import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loopbackPort, proxiedUrl, settingPorts } from '../wheelhouse/server/addresses.js';

const viewer = { protocol: 'http:', hostname: 'localhost', port: '4310' };

describe('loopbackPort', () => {
	it('finds the port of an http address on this computer', () => {
		assert.equal(loopbackPort('http://localhost:5173/app'), 5173);
		assert.equal(loopbackPort('http://127.0.0.1:4397/'), 4397);
		assert.equal(loopbackPort('http://LOCALHOST/'), 80);
	});

	it('leaves https, other hosts, credentials and junk alone', () => {
		for (const raw of [
			'https://localhost:5173/',
			'http://example.com:5173/',
			'http://192.168.1.4:5173/',
			'http://[::1]:5173/',
			'http://0.0.0.0:5173/',
			'http://localhost.evil.test:5173/',
			'http://user:pw@localhost:5173/',
			'ws://localhost:5173/',
			'not a url'
		]) {
			assert.equal(loopbackPort(raw), null, raw);
		}
	});
});

describe('proxiedUrl', () => {
	it('sends an address on this computer through the port the viewer reached Wheelhouse on', () => {
		assert.equal(
			proxiedUrl('http://localhost:5173/app/page?x=1#top', viewer),
			'http://5173.localhost:4310/app/page?x=1#top'
		);
		assert.equal(proxiedUrl('http://127.0.0.1:3000', viewer), 'http://3000.localhost:4310/');
		// Forwarded to another port, or reached by its IP address, it follows the viewer.
		assert.equal(
			proxiedUrl('http://localhost:5173/', {
				protocol: 'http:',
				hostname: '127.0.0.1',
				port: '8080'
			}),
			'http://5173.localhost:8080/'
		);
		assert.equal(
			proxiedUrl('http://localhost:5173/', { protocol: 'https:', hostname: 'localhost', port: '' }),
			'https://5173.localhost/'
		);
	});

	it('leaves Wheelhouse’s own address and anything not on this computer alone', () => {
		for (const raw of [
			'http://localhost:4310/tasks/a',
			'http://127.0.0.1:4310/',
			'https://localhost:5173/',
			'https://github.com/o/r/pull/1',
			'/tasks/a',
			'mailto:a@b.c'
		]) {
			assert.equal(proxiedUrl(raw, viewer), raw);
		}
	});

	it('rewrites a redirect from the proxied page’s own port to another app', () => {
		const proxied = { protocol: 'http:', hostname: '5173.localhost', port: '4310' };
		assert.equal(
			proxiedUrl('http://localhost:5173/next', proxied),
			'http://5173.localhost:4310/next'
		);
		assert.equal(proxiedUrl('http://localhost:4310/', proxied), 'http://4310.localhost:4310/');
	});
});

describe('settingPorts', () => {
	it('keeps whole port numbers from a list or comma-separated text', () => {
		assert.deepEqual(
			settingPorts(['3000', ' 8080 ', '3000', 'x', '0', '70000', '-1', '1.5']),
			[3000, 8080]
		);
		assert.deepEqual(settingPorts('3000, 8080'), [3000, 8080]);
		assert.deepEqual(settingPorts(undefined), []);
		assert.deepEqual(settingPorts(42), []);
	});
});
