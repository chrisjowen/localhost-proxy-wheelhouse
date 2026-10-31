/** Addresses on Wheelhouse's computer, and the ports the plugin's settings allow. */

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
/** @param {number} n */
const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;

/**
 * The port an http address on this computer is on, or null for any other address.
 *
 * @param {string} raw
 * @returns {number | null}
 */
export function loopbackPort(raw) {
	const u = URL.parse(raw);
	if (!u || u.protocol !== 'http:' || u.username || u.password) return null;
	if (!LOOPBACK.has(u.hostname.toLowerCase())) return null;
	const port = u.port ? Number(u.port) : 80;
	return validPort(port) ? port : null;
}

/**
 * The ports the plugin's `ports` setting allows: whole numbers 1-65535, the rest ignored.
 *
 * @param {unknown} value
 * @returns {number[]}
 */
export function settingPorts(value) {
	const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
	const ports = new Set();
	for (const item of items) {
		const text = String(item).trim();
		if (!/^\d{1,5}$/.test(text)) continue;
		const port = Number(text);
		if (validPort(port)) ports.add(port);
	}
	return [...ports];
}
