import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect, createServer as createRawServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import {
	hostOnlyCookie,
	LocalProxy,
	requestHeaders,
	rewriteLocation
} from '../wheelhouse/server/proxy.js';

/**
 * The localhost proxy against a real app on loopback: a page with a root-path
 * asset, a client-side route, a redirect to its own address, a cookie, a form
 * post and a WebSocket (as Vite's HMR uses), all reached through a server
 * that hands `<port>.localhost` requests to the host route as Wheelhouse's
 * does (Wheelhouse itself refuses other origins' changes and sockets first).
 *
 * @typedef {import('node:http').Server} Server
 * @typedef {import('node:http').IncomingHttpHeaders} IncomingHttpHeaders
 * @typedef {import('../wheelhouse/server/proxy.js').RouteContext} RouteContext
 */

/** @param {Server} server */
const listen = (server) =>
	new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () =>
			resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port)
		)
	);

/** @type {Server} */
let app;
/** @type {number} */
let appPort;
/** @type {WebSocketServer} */
let wss;
/** @type {Server} */
let front;
/** @type {number} */
let frontPort;
/** @type {Record<string, unknown>} */
let settings;
/** @type {Set<number>} */
let reported;
/** @type {number[]} */
let reserved;
/** The headers the app last saw. @type {IncomingHttpHeaders} */
let seen;
/** While set, the route waits on it before learning the reported addresses. @type {Promise<void> | null} */
let held;

before(async () => {
	app = createServer((req, res) => {
		seen = req.headers;
		if (req.url === '/') {
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end('<script type="module" src="/@vite/client"></script><h1>Lumen</h1>');
		} else if (req.url === '/@vite/client') {
			res.writeHead(200, { 'content-type': 'text/javascript' });
			res.end('new WebSocket(`ws://${location.host}/`, "vite-hmr")');
		} else if (req.url === '/login') {
			res.writeHead(302, {
				location: `http://localhost:${appPort}/dashboard?next=1`,
				'set-cookie': ['sid=abc; Path=/; Domain=localhost; HttpOnly', 'theme=dark; Path=/']
			});
			res.end();
		} else if (req.method === 'POST') {
			let body = '';
			req.on('data', (c) => (body += c));
			req.on('end', () => {
				res.writeHead(200, { 'content-type': 'text/plain' });
				res.end(`got ${body}`);
			});
		} else {
			// Any other path is a client-side route: the app's shell answers it.
			res.writeHead(200, { 'content-type': 'text/html' });
			res.end(`<h1>Lumen</h1><p>route ${req.url}</p>`);
		}
	});
	wss = new WebSocketServer({ server: app });
	wss.on('connection', (ws, req) => {
		ws.send(`hello ${req.headers.origin} ${req.headers.host}`);
		ws.on('message', (m) => ws.send(`echo ${m}`));
	});
	appPort = await listen(app);

	const proxy = new LocalProxy({ targets: ['127.0.0.1'] });
	// What Wheelhouse hands the route for `<port>.localhost` (see its docs/plugins.md).
	/** @returns {RouteContext | null} */
	const ctxFor = (/** @type {string} */ host) => {
		const m = /^(\d+)\.localhost(?::\d+)?$/.exec(host);
		if (!m) return null;
		return {
			host,
			origin: `http://${host}`,
			port: Number(m[1]),
			settings,
			loopbackAddresses: async () => {
				await held;
				return [...reported].map((p) => `http://localhost:${p}/`);
			},
			reservedPorts: () => [frontPort, ...reserved]
		};
	};
	front = createServer((req, res) => {
		const ctx = ctxFor(req.headers.host ?? '');
		if (ctx) return proxy.request(req, res, ctx);
		res.writeHead(200);
		res.end('wheelhouse');
	});
	front.on('upgrade', (req, socket, head) => {
		const ctx = ctxFor(req.headers.host ?? '');
		if (ctx) proxy.upgrade(req, socket, head, ctx);
		else socket.destroy();
	});
	frontPort = await listen(front);
});

after(() => {
	wss.close();
	app.close();
	app.closeAllConnections();
	front.close();
	front.closeAllConnections();
});

beforeEach(() => {
	settings = {};
	reported = new Set([appPort]);
	reserved = [];
	held = null;
});

/**
 * A bare app on loopback that answers each connection with `reply`, counting them.
 *
 * @param {string} reply
 */
async function rawApp(reply) {
	const raw = { connections: 0, port: 0, close: () => {} };
	const server = createRawServer((sock) => {
		raw.connections++;
		sock.on('error', () => {});
		sock.once('data', () => sock.end(reply));
	});
	raw.port = await listen(/** @type {any} */ (server));
	raw.close = () => server.close();
	return raw;
}

/** @param {number} port */
const hostFor = (port) => `${port}.localhost:${frontPort}`;
/** @param {number} port */
const originFor = (port) => `http://${hostFor(port)}`;

/**
 * @param {string} path
 * @param {{ host?: string; method?: string; headers?: Record<string, string>; body?: string }} [opts]
 * @returns {Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>}
 */
function get(path, opts = {}) {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port: frontPort,
				path,
				method: opts.method ?? 'GET',
				headers: { host: opts.host ?? hostFor(appPort), ...opts.headers }
			},
			(res) => {
				let body = '';
				res.on('data', (c) => (body += c));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			}
		);
		req.on('error', reject);
		req.end(opts.body);
	});
}

/**
 * @param {string} origin
 * @param {string} [host]
 * @returns {Promise<string[]>}
 */
function socket(origin, host = hostFor(appPort)) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/`, 'vite-hmr', {
			headers: { host },
			origin
		});
		/** @type {string[]} */
		const got = [];
		ws.on('message', (m) => {
			got.push(String(m));
			if (got.length === 1) ws.send('ping');
			else ws.close();
		});
		ws.on('close', () => resolve(got));
		ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
		ws.on('error', reject);
	});
}

describe('a proxied page', () => {
	it('serves the app’s HTML, root-path assets and client-side routes on its own origin', async () => {
		const page = await get('/');
		assert.equal(page.status, 200);
		assert.match(page.body, /<h1>Lumen<\/h1>/);
		// The app sees its own address, as it would without the proxy.
		assert.equal(seen.host, `localhost:${appPort}`);
		const asset = await get('/@vite/client');
		assert.equal(asset.headers['content-type'], 'text/javascript');
		assert.match((await get('/projects/7?tab=a')).body, /route \/projects\/7\?tab=a/);
	});

	it('rewrites a redirect to the app’s own address, and keeps its cookies to the proxied one', async () => {
		const r = await get('/login');
		assert.equal(r.status, 302);
		assert.equal(r.headers.location, `${originFor(appPort)}/dashboard?next=1`);
		assert.deepEqual(r.headers['set-cookie'], ['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/']);
	});

	it('passes a post from the page’s own origin, which the app sees as its own', async () => {
		const r = await get('/save', {
			method: 'POST',
			headers: { origin: originFor(appPort), 'content-type': 'text/plain' },
			body: 'draft'
		});
		assert.equal(r.status, 200);
		assert.equal(r.body, 'got draft');
		assert.equal(seen.origin, `http://localhost:${appPort}`);
	});

	it('carries a WebSocket both ways, as Vite’s HMR uses one', async () => {
		assert.deepEqual(await socket(originFor(appPort)), [
			`hello http://localhost:${appPort} localhost:${appPort}`,
			'echo ping'
		]);
	});
});

describe('what the proxy refuses', () => {
	// Other hosts, a plugin that is off and other origins are Wheelhouse's to refuse, before the route.
	it('opens only ports the crew reported, or the settings list', async () => {
		reported = new Set();
		const r = await get('/');
		assert.equal(r.status, 403);
		assert.match(String(r.headers['content-type']), /text\/html/);
		assert.ok(r.body.includes(`Nothing has reported port ${appPort}`));
		assert.ok(r.body.includes('More ports to allow'));
		await assert.rejects(socket(originFor(appPort)), /refused 403/);

		settings = { ports: [String(appPort)] };
		assert.equal((await get('/')).status, 200);
	});

	it('never opens Wheelhouse’s own port or a reserved one, even when listed', async () => {
		settings = { ports: [String(frontPort), String(appPort)] };
		const own = await get('/', { host: hostFor(frontPort) });
		assert.equal(own.status, 403);
		assert.ok(own.body.includes('Wheelhouse’s own'));
		await assert.rejects(socket(originFor(frontPort), hostFor(frontPort)), /refused 403/);
		reserved = [appPort];
		assert.equal((await get('/')).status, 403);
	});

	it('says so plainly when nothing answers on the port', async () => {
		reported = new Set([1]);
		const r = await get('/', { host: hostFor(1) });
		assert.equal(r.status, 502);
		assert.ok(r.body.includes('nothing answered on that port'));
		await assert.rejects(socket(originFor(1), hostFor(1)), /refused 502/);
	});
});

describe('when things go wrong mid-way', () => {
	it('passes a viewer’s half-close on to the app through a working tunnel', async () => {
		const server = createRawServer({ allowHalfOpen: true }, (sock) => {
			let got = '';
			sock.once('data', () => {
				sock.write(
					'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n'
				);
				sock.on('data', (c) => (got += c));
				sock.on('end', () => sock.end(`got ${got}`));
			});
		});
		const port = await listen(/** @type {any} */ (server));
		reported = new Set([port]);
		try {
			const reply = await new Promise((resolve, reject) => {
				const viewer = connect({ host: '127.0.0.1', port: frontPort, allowHalfOpen: true }, () =>
					viewer.write(
						`GET / HTTP/1.1\r\nHost: ${hostFor(port)}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`
					)
				);
				let text = '';
				viewer.on('data', (c) => {
					text += c;
					if (text.includes('\r\n\r\n') && !viewer.writableEnded) viewer.end('bye');
				});
				viewer.on('end', () => resolve(text.slice(text.indexOf('\r\n\r\n') + 4)));
				viewer.on('error', reject);
			});
			assert.equal(reply, 'got bye');
		} finally {
			server.close();
		}
	});

	it('passes on an app’s chunked refusal of a WebSocket as a readable answer', async () => {
		const raw = await rawApp(
			'HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nnope!\r\n0\r\n\r\n'
		);
		reported = new Set([raw.port]);
		try {
			const r = await get('/', {
				host: hostFor(raw.port),
				headers: { connection: 'Upgrade', upgrade: 'websocket', origin: originFor(raw.port) }
			});
			assert.equal(r.status, 400);
			assert.equal(r.body, 'nope!');
		} finally {
			raw.close();
		}
	});

	it('never opens the app’s port for a viewer that left while it was being checked', async () => {
		const raw = await rawApp('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
		reported = new Set([raw.port]);
		/** @type {() => void} */
		let release = () => {};
		held = new Promise((r) => (release = r));
		try {
			const page = request({
				host: '127.0.0.1',
				port: frontPort,
				path: '/',
				headers: { host: hostFor(raw.port) }
			});
			page.on('error', () => {});
			page.end();
			const ws = new WebSocket(`ws://127.0.0.1:${frontPort}/`, {
				headers: { host: hostFor(raw.port) },
				origin: originFor(raw.port)
			});
			ws.on('error', () => {});
			await delay(50);
			page.destroy();
			ws.terminate();
			await delay(50);
			release();
			await delay(100);
			assert.equal(raw.connections, 0);
		} finally {
			raw.close();
		}
	});
});

describe('header rewriting', () => {
	it('passes the app its own address and drops hop-by-hop headers', () => {
		const host = '5173.localhost:4310';
		assert.deepEqual(
			requestHeaders(
				{
					host,
					origin: 'http://5173.localhost:4310',
					referer: 'http://5173.localhost:4310/a?b=1',
					connection: 'keep-alive, x-secret',
					'x-secret': 'hop',
					'proxy-authorization': 'Basic x',
					accept: 'text/html'
				},
				5173,
				host,
				false
			),
			{
				host: 'localhost:5173',
				origin: 'http://localhost:5173',
				referer: 'http://localhost:5173/a?b=1',
				accept: 'text/html'
			}
		);
	});

	it('keeps a foreign Origin as it is, so the app can refuse it too', () => {
		const out = requestHeaders({ origin: 'http://evil.test' }, 5173, '5173.localhost:4310', false);
		assert.equal(out.origin, 'http://evil.test');
	});

	it('rewrites redirects on this computer only', () => {
		const host = '5173.localhost:4310';
		assert.equal(rewriteLocation('http://127.0.0.1:5173/x', host), 'http://5173.localhost:4310/x');
		assert.equal(
			rewriteLocation('http://localhost:3000/app/page?x=1#top', host),
			'http://3000.localhost:4310/app/page?x=1#top'
		);
		assert.equal(rewriteLocation('http://localhost:3000', host), 'http://3000.localhost:4310/');
		assert.equal(rewriteLocation('https://localhost:5173/', host), 'https://localhost:5173/');
		assert.equal(rewriteLocation('/relative', host), '/relative');
		assert.equal(rewriteLocation('https://github.com/login', host), 'https://github.com/login');
	});

	it('drops a cookie’s Domain', () => {
		assert.equal(hostOnlyCookie('a=1; Domain=.localhost; Path=/'), 'a=1; Path=/');
		assert.equal(hostOnlyCookie('a=1;domain=localhost'), 'a=1');
	});
});
