/**
 * The localhost proxy, as a Wheelhouse host route for `{port}.localhost`.
 * Wheelhouse hands it a request only while the plugin is on, and only after
 * refusing any change or WebSocket from another origin (see Wheelhouse's
 * docs/plugins.md, Host routes and address rewrites). It forwards to that port
 * on this computer's loopback (127.0.0.1, else ::1) and nowhere else: the
 * target host is never taken from the request.
 *
 * It opens a port only when the crew has reported an address on it
 * (`ctx.loopbackAddresses()`), or the plugin's `ports` setting lists it; never
 * one of Wheelhouse's own (`ctx.reservedPorts()`). The proxied app sees its
 * own address (Host, Origin and Referer are rewritten to `localhost:<port>`),
 * and redirects and cookies it sends are rewritten to the proxied address.
 * Bodies pass through untouched.
 *
 * @typedef {import('node:http').IncomingMessage} IncomingMessage
 * @typedef {import('node:http').ServerResponse} ServerResponse
 * @typedef {import('node:http').IncomingHttpHeaders} IncomingHttpHeaders
 * @typedef {import('node:http').OutgoingHttpHeaders} OutgoingHttpHeaders
 * @typedef {import('node:net').Socket} Socket
 * @typedef {import('node:stream').Duplex} Duplex
 *
 * What Wheelhouse hands a host route beside the request (the SDK's HostRouteContext).
 * @typedef {{
 *   host: string;
 *   origin: string;
 *   port: number;
 *   settings: Record<string, unknown>;
 *   loopbackAddresses(): Promise<string[]>;
 *   reservedPorts(): number[];
 * }} RouteContext
 *
 * @typedef {{ ok: true; port: number } | { ok: false; status: number; page: string }} Verdict
 * @typedef {{ title: string; lines: string[] }} Explained
 */

import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { loopbackPort, settingPorts } from './addresses.js';

/** Hop-by-hop headers, never passed on in either direction. */
const HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-connection',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'upgrade'
]);

export class LocalProxy {
	/**
	 * @param {{ targets?: string[]; connectTimeoutMs?: number }} [opts] `targets` are the
	 *   loopback addresses tried in turn; tests may narrow them.
	 */
	constructor(opts = {}) {
		/** @type {string[]} */
		this.targets = opts.targets ?? ['127.0.0.1', '::1'];
		this.connectTimeoutMs = opts.connectTimeoutMs ?? 3_000;
	}

	/**
	 * @param {IncomingMessage} req
	 * @param {ServerResponse} res
	 * @param {RouteContext} ctx
	 */
	request(req, res, ctx) {
		void this.forward(req, res, ctx).catch(() => {
			if (!res.headersSent) send(res, 502, page(NOT_ANSWERING));
			else res.destroy();
		});
	}

	/**
	 * @param {IncomingMessage} req
	 * @param {Duplex} socket
	 * @param {Buffer} head
	 * @param {RouteContext} ctx
	 */
	upgrade(req, socket, head, ctx) {
		socket.on('error', () => socket.destroy());
		void this.tunnel(req, socket, head, ctx).catch(() => socket.destroy());
	}

	/**
	 * Whether the port may be opened.
	 *
	 * @param {RouteContext} ctx
	 * @param {string} path
	 * @returns {Promise<Verdict>}
	 */
	async check(ctx, path) {
		const port = ctx.port;
		if (ctx.reservedPorts().includes(port)) {
			return { ok: false, status: 403, page: page(ownPort(port)) };
		}
		const listed = settingPorts(ctx.settings.ports).includes(port);
		const reported =
			listed || (await ctx.loopbackAddresses()).some((a) => loopbackPort(a) === port);
		if (!reported) {
			return { ok: false, status: 403, page: page(notShared(port, ctx.host, path)) };
		}
		return { ok: true, port };
	}

	/**
	 * @param {IncomingMessage} req
	 * @param {ServerResponse} res
	 * @param {RouteContext} ctx
	 */
	async forward(req, res, ctx) {
		const gone = new AbortController();
		res.on('close', () => gone.abort());
		const verdict = await this.check(ctx, req.url ?? '/');
		if (!verdict.ok) return send(res, verdict.status, verdict.page);
		const upstream = await this.connect(verdict.port, gone.signal);
		if (!upstream) return send(res, 502, page(NOT_ANSWERING));
		const host = ctx.host;
		const out = httpRequest({
			createConnection: () => upstream,
			method: req.method,
			path: req.url,
			headers: requestHeaders(req.headers, verdict.port, host, false),
			signal: gone.signal
		});
		out.on('response', (up) => {
			res.writeHead(up.statusCode ?? 502, up.statusMessage, responseHeaders(up.headers, host));
			up.pipe(res);
			up.on('error', () => res.destroy());
		});
		out.on('error', () => {
			if (!res.headersSent) send(res, 502, page(NOT_ANSWERING));
			else res.destroy();
		});
		req.pipe(out);
	}

	/**
	 * @param {IncomingMessage} req
	 * @param {Duplex} socket
	 * @param {Buffer} head
	 * @param {RouteContext} ctx
	 */
	async tunnel(req, socket, head, ctx) {
		const gone = new AbortController();
		const leave = () => gone.abort();
		socket.on('close', leave);
		socket.on('end', leave);
		const verdict = await this.check(ctx, req.url ?? '/');
		if (!verdict.ok) return refuse(socket, verdict.status, 'Not shared through Wheelhouse.');
		const upstream = await this.connect(verdict.port, gone.signal);
		if (!upstream) return refuse(socket, 502, 'Nothing is answering on that port.');
		const host = ctx.host;
		const out = httpRequest({
			createConnection: () => upstream,
			method: req.method,
			path: req.url,
			headers: requestHeaders(req.headers, verdict.port, host, true),
			signal: gone.signal
		});
		out.on('upgrade', (up, upSocket, upHead) => {
			socket.off('close', leave);
			socket.off('end', leave);
			upSocket.on('error', () => socket.destroy());
			socket.on('close', () => upSocket.destroy());
			upSocket.on('close', () => socket.destroy());
			socket.write(statusLine(up) + rawHeaders(up.rawHeaders, host));
			if (upHead.length) socket.write(upHead);
			if (head.length) upSocket.write(head);
			upSocket.pipe(socket).pipe(upSocket);
		});
		// The app answered without switching protocols: pass that answer on and close.
		out.on('response', (up) => {
			socket.off('end', leave);
			socket.write(
				statusLine(up) +
					rawHeaders(up.rawHeaders, host, ['connection', 'transfer-encoding', 'content-length'])
			);
			up.pipe(socket);
		});
		out.on('error', () => socket.destroy());
		out.end();
	}

	/**
	 * A connection to the port on loopback, trying each address in turn; null when none answers.
	 *
	 * @param {number} port
	 * @param {AbortSignal} [signal] Gives up, closing any connection, once the viewer has left.
	 * @returns {Promise<Socket | null>}
	 */
	async connect(port, signal) {
		for (const host of this.targets) {
			if (signal?.aborted) return null;
			/** @type {Socket | null} */
			const socket = await new Promise((resolve) => {
				const s = connect({ host, port, signal });
				const timer = setTimeout(() => {
					s.destroy();
					resolve(null);
				}, this.connectTimeoutMs);
				s.once('connect', () => {
					clearTimeout(timer);
					resolve(s);
				});
				s.once('error', () => {
					clearTimeout(timer);
					resolve(null);
				});
			});
			if (socket) return socket;
		}
		return null;
	}
}

/**
 * The origin a proxied page was served from, as its Host names it.
 *
 * @param {string} host
 */
const served = (host) => `http://${host}`;

/**
 * The headers passed on to the app: hop-by-hop removed, its own address in Host, Origin and Referer.
 *
 * @param {IncomingHttpHeaders} headers
 * @param {number} port
 * @param {string} host
 * @param {boolean} upgrade
 * @returns {OutgoingHttpHeaders}
 */
export function requestHeaders(headers, port, host, upgrade) {
	const listed = new Set(
		String(headers.connection ?? '')
			.split(',')
			.map((h) => h.trim().toLowerCase())
	);
	/** @type {OutgoingHttpHeaders} */
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP.has(name) || listed.has(name)) continue;
		out[name] = value;
	}
	const own = `http://localhost:${port}`;
	out.host = `localhost:${port}`;
	if (out.origin === served(host)) out.origin = own;
	const referer = typeof out.referer === 'string' ? out.referer : null;
	if (referer?.startsWith(`${served(host)}/`))
		out.referer = own + referer.slice(served(host).length);
	if (upgrade) {
		out.connection = 'Upgrade';
		out.upgrade = headers.upgrade;
	}
	return out;
}

/**
 * The app's response headers for the viewer: hop-by-hop removed, redirects and cookies rewritten.
 *
 * @param {IncomingHttpHeaders} headers
 * @param {string} host
 * @returns {OutgoingHttpHeaders}
 */
export function responseHeaders(headers, host) {
	/** @type {OutgoingHttpHeaders} */
	const out = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP.has(name)) continue;
		out[name] = value;
	}
	if (typeof out.location === 'string') out.location = rewriteLocation(out.location, host);
	if (Array.isArray(out['set-cookie'])) out['set-cookie'] = out['set-cookie'].map(hostOnlyCookie);
	return out;
}

/**
 * A redirect to an address on this computer, through the proxy (the same
 * app's own address becomes the proxied page's origin); any other is kept.
 *
 * @param {string} location
 * @param {string} host
 */
export function rewriteLocation(location, host) {
	const port = loopbackPort(location);
	if (port === null) return location;
	const u = new URL(location);
	const at = host.split(':')[1];
	return `http://${port}.localhost${at ? `:${at}` : ''}${u.pathname}${u.search}${u.hash}`;
}

/**
 * A cookie kept to the proxied address alone: any Domain attribute is dropped.
 *
 * @param {string} cookie
 */
export function hostOnlyCookie(cookie) {
	return cookie.replace(/;\s*domain=[^;]*/gi, '');
}

/** @param {IncomingMessage} up */
function statusLine(up) {
	return `HTTP/1.1 ${up.statusCode} ${up.statusMessage ?? ''}\r\n`;
}

/**
 * A raw response head for a socket, with Location and cookies rewritten as for any response.
 *
 * @param {string[]} raw
 * @param {string} host
 * @param {string[]} [drop]
 */
function rawHeaders(raw, host, drop = []) {
	let head = '';
	for (let i = 0; i + 1 < raw.length; i += 2) {
		const name = raw[i];
		let value = raw[i + 1];
		const lower = name.toLowerCase();
		if (drop.includes(lower)) continue;
		if (lower === 'location') value = rewriteLocation(value, host);
		if (lower === 'set-cookie') value = hostOnlyCookie(value);
		head += `${name}: ${value}\r\n`;
	}
	return `${head}${drop.includes('connection') ? 'Connection: close\r\n' : ''}\r\n`;
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {string} body
 */
function send(res, status, body) {
	const html = body.startsWith('<!doctype html>');
	res.writeHead(status, {
		'content-type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff'
	});
	res.end(body);
}

/**
 * Refuse an upgrade with a plain HTTP error and close the socket.
 *
 * @param {Duplex} socket
 * @param {number} status
 * @param {string} message
 */
function refuse(socket, status, message) {
	if (socket.destroyed) return;
	const body = `${message}\n`;
	socket.end(
		`HTTP/1.1 ${status} ${status === 502 ? 'Bad Gateway' : 'Forbidden'}\r\n` +
			'Connection: close\r\nContent-Type: text/plain; charset=utf-8\r\n' +
			`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
	);
}

/** @param {string} s */
const escape = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** @type {Explained} */
const NOT_ANSWERING = {
	title: 'Nothing is answering here',
	lines: [
		'Wheelhouse passed this address on to its own computer, but nothing answered on that port.',
		'If a preview was running there, it has stopped. Ask the crew to start it again, then reload this page.'
	]
};

/**
 * @param {number} port
 * @returns {Explained}
 */
function ownPort(port) {
	return {
		title: 'Not shared through Wheelhouse',
		lines: [`Port ${port} is Wheelhouse’s own, which its localhost proxy never opens.`]
	};
}

/**
 * @param {number} port
 * @param {string} host
 * @param {string} path
 * @returns {Explained}
 */
function notShared(port, host, path) {
	const direct = `http://localhost:${port}${path.startsWith('/') ? path : '/'}`;
	const at = host.split(':')[1];
	const settings = `http://localhost${at ? `:${at}` : ''}/settings/plugins/localhost-proxy`;
	return {
		title: 'Not shared through Wheelhouse',
		lines: [
			`Wheelhouse’s localhost proxy opens only the ports the crew has reported an address on, and those its settings list. Nothing has reported port ${port}.`,
			`To open it anyway, add ${port} to <b>More ports to allow</b> on the Localhost proxy’s page under <a href="${escape(settings)}">Settings → Plugins</a>, then reload this page.`,
			`On Wheelhouse’s own computer you can also open it directly: <a href="${escape(direct)}">${escape(direct)}</a>.`
		]
	};
}

/**
 * A small page in Wheelhouse's own colours that says, in plain words, why.
 *
 * @param {Explained} explained
 */
function page({ title, lines }) {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#f7f3ea;--fg:#14233c;--muted:#5b6578;--sea:#1f5f8b;--rule:#d9d1c0}
@media (prefers-color-scheme:dark){:root{--bg:#0f1a2c;--fg:#ece6d8;--muted:#a3abba;--sea:#7fb4dc;--rule:#2a3a55}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,sans-serif}
main{max-width:40rem;padding:3rem 1rem}
h1{font:600 1.5rem/1.3 Georgia,serif;margin:0 0 1rem;padding-bottom:.75rem;border-bottom:1px solid var(--rule)}
p{margin:0 0 .75rem;color:var(--muted)}a{color:var(--sea)}b{color:var(--fg)}
</style></head>
<body><main><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}</main></body></html>`;
}
