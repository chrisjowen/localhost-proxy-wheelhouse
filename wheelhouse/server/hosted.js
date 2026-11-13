/**
 * Hosted dev environments, and the public address each serves a port at.
 *
 * When Wheelhouse runs in GitHub Codespaces, Gitpod or Ona, or on a remote
 * machine, a port on its computer is reachable from the viewer's browser at a
 * public address of the environment's own, such as
 * `https://my-codespace-5173.app.github.dev`. An address pattern says where:
 * an http(s) address with `{port}` once in it, such as
 * `https://my-codespace-{port}.app.github.dev` or `http://my-vm.example.dev:{port}`.
 * The plugin's `publicAddress` setting gives one by hand; otherwise one is
 * worked out from the environment variables Codespaces and Gitpod set.
 */

import { loopbackPort } from './addresses.js';

/** @typedef {{ name: string; pattern: string }} Hosted */

/** @typedef {Record<string, string | undefined>} Env */

/**
 * Whether `pattern` is an address pattern: an http(s) address, with no
 * credentials, query or fragment, and `{port}` once, where a port fills it.
 *
 * @param {unknown} pattern
 * @returns {pattern is string}
 */
export function validPattern(pattern) {
	if (typeof pattern !== 'string' || pattern.length > 400) return false;
	if (pattern.split('{port}').length !== 2) return false;
	const filled = [1, 2].map((port) => URL.parse(pattern.replace('{port}', String(port))));
	return (
		filled.every(
			(u) =>
				u !== null &&
				(u.protocol === 'http:' || u.protocol === 'https:') &&
				!u.username &&
				!u.password &&
				!u.search &&
				!u.hash &&
				!/[{}]/.test(u.href)
		) && filled[0]?.href !== filled[1]?.href
	);
}

/**
 * The hosted environment Wheelhouse runs in and its address pattern, from the
 * variables the environment sets; null when none is recognised.
 *
 * - GitHub Codespaces sets `CODESPACES=true`, `CODESPACE_NAME` and
 *   `GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN`: a port is at
 *   `https://<name>-<port>.<domain>`.
 * - Gitpod (Ona's Gitpod Classic workspaces) sets `GITPOD_WORKSPACE_URL`,
 *   such as `https://abc123.ws-eu45.gitpod.io`: a port is at that address
 *   with the port before it, `https://<port>-abc123.ws-eu45.gitpod.io`.
 *
 * Ona environments set no variable a port's address can be worked out from
 * (`ona environment port open <port>` prints it), so they take the setting.
 *
 * @param {Env} env
 * @returns {Hosted | null}
 */
export function hostedEnvironment(env) {
	const name = env.CODESPACE_NAME?.trim().toLowerCase();
	const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim().toLowerCase();
	if (env.CODESPACES === 'true' && name && domain) {
		const pattern = `https://${name}-{port}.${domain}`;
		if (validHostPattern(pattern)) return { name: 'GitHub Codespaces', pattern };
	}
	const workspace = URL.parse(env.GITPOD_WORKSPACE_URL?.trim() ?? '');
	if (workspace?.protocol === 'https:' && workspace.hostname && !workspace.port) {
		const pattern = `https://{port}-${workspace.hostname}`;
		if (validHostPattern(pattern)) return { name: 'Gitpod', pattern };
	}
	return null;
}

/**
 * The address pattern to show ports at: the `publicAddress` setting when it
 * is a valid pattern, else the hosted environment's; null when there is neither.
 *
 * @param {Record<string, unknown>} settings
 * @param {Env} env
 * @returns {Hosted | null}
 */
export function publicPattern(settings, env) {
	const set = typeof settings.publicAddress === 'string' ? settings.publicAddress.trim() : '';
	if (set && validPattern(set))
		return { name: 'the plugin’s Public address setting', pattern: set };
	return hostedEnvironment(env);
}

/**
 * Where the viewer's browser can open `raw`, an http address on Wheelhouse's
 * computer, under `pattern`: its path, query and fragment follow the pattern's
 * own path. Null for any other address.
 *
 * @param {string} raw
 * @param {string} pattern
 * @returns {string | null}
 */
export function publicPortUrl(raw, pattern) {
	const port = loopbackPort(raw);
	if (port === null || !validPattern(pattern)) return null;
	const u = new URL(raw);
	const base = new URL(pattern.replace('{port}', String(port)));
	return `${base.origin}${base.pathname.replace(/\/$/, '')}${u.pathname}${u.search}${u.hash}`;
}

/**
 * A pattern whose `{port}` sits in a host name an environment variable built.
 *
 * @param {string} pattern
 */
function validHostPattern(pattern) {
	return validPattern(pattern) && URL.parse(pattern.replace('{port}', '1'))?.pathname === '/';
}
