/**
 * Localhost proxy, a Wheelhouse plugin. While it is on, Wheelhouse shows each
 * http address on its own computer at `{port}.localhost` on the port the
 * viewer reached it on (the manifest's address rewrite), and hands requests
 * for that name to this plugin's host route, which passes them on to that
 * port on Wheelhouse's loopback. See README.md.
 */
import { LocalProxy } from './proxy.js';

const proxy = new LocalProxy();

export default {
	providers: [],
	contributions: [],
	hostRoutes: [
		{
			id: 'proxy',
			request: proxy.request.bind(proxy),
			upgrade: proxy.upgrade.bind(proxy)
		}
	]
};
