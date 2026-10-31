import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loopbackPort, settingPorts } from '../wheelhouse/server/addresses.js';

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
