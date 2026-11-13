import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	hostedEnvironment,
	publicPattern,
	publicPortUrl,
	validPattern
} from '../wheelhouse/server/hosted.js';

const CODESPACES = {
	CODESPACES: 'true',
	CODESPACE_NAME: 'octocat-literate-space-parakeet-mld5',
	GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev'
};
const GITPOD = { GITPOD_WORKSPACE_URL: 'https://abc123-demo-x1y2.ws-eu45.gitpod.io' };

describe('hostedEnvironment', () => {
	it('finds a codespace, and the address its ports are forwarded at', () => {
		const hosted = hostedEnvironment(CODESPACES);
		assert.deepEqual(hosted, {
			name: 'GitHub Codespaces',
			pattern: 'https://octocat-literate-space-parakeet-mld5-{port}.app.github.dev'
		});
		assert.equal(
			publicPortUrl('http://localhost:5173/app?x=1#top', String(hosted?.pattern)),
			'https://octocat-literate-space-parakeet-mld5-5173.app.github.dev/app?x=1#top'
		);
	});

	it('finds a Gitpod workspace, whose ports are at its address with the port before it', () => {
		const hosted = hostedEnvironment(GITPOD);
		assert.deepEqual(hosted, {
			name: 'Gitpod',
			pattern: 'https://{port}-abc123-demo-x1y2.ws-eu45.gitpod.io'
		});
		assert.equal(
			publicPortUrl('http://127.0.0.1:3000/', String(hosted?.pattern)),
			'https://3000-abc123-demo-x1y2.ws-eu45.gitpod.io/'
		);
	});

	it('prefers Codespaces when both are set', () => {
		assert.equal(hostedEnvironment({ ...GITPOD, ...CODESPACES })?.name, 'GitHub Codespaces');
	});

	it('finds nothing on an ordinary computer, or from half-set or odd variables', () => {
		for (const env of [
			{},
			{ HOME: '/home/me', PORT: '4310' },
			{ ...CODESPACES, CODESPACES: 'false' },
			{ CODESPACES: 'true', CODESPACE_NAME: 'x' },
			{ CODESPACES: 'true', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' },
			{ ...CODESPACES, CODESPACE_NAME: 'a/b' },
			{ GITPOD_WORKSPACE_URL: '' },
			{ GITPOD_WORKSPACE_URL: 'not a url' },
			{ GITPOD_WORKSPACE_URL: 'http://abc.ws-eu45.gitpod.io' },
			{ GITPOD_WORKSPACE_URL: 'https://abc.ws-eu45.gitpod.io:8443' }
		]) {
			assert.equal(hostedEnvironment(env), null, JSON.stringify(env));
		}
	});
});

describe('publicPattern', () => {
	it('takes the Public address setting first, for Ona or any other host', () => {
		const pattern = 'https://{port}--01abc.eu.example.dev';
		assert.deepEqual(publicPattern({ publicAddress: ` ${pattern} ` }, CODESPACES), {
			name: 'the plugin’s Public address setting',
			pattern
		});
	});

	it('falls back to the environment when the setting is empty or not a pattern', () => {
		for (const publicAddress of [undefined, '', '  ', 'https://example.dev', 42]) {
			assert.equal(publicPattern({ publicAddress }, GITPOD)?.name, 'Gitpod');
		}
	});

	it('is null on an ordinary computer with no setting, so the proxy keeps to localhost', () => {
		assert.equal(publicPattern({}, {}), null);
		assert.equal(publicPattern({ ports: ['3000'] }, { HOME: '/home/me' }), null);
	});
});

describe('validPattern', () => {
	it('takes http(s) addresses with {port} once, in the host, port or path', () => {
		for (const p of [
			'https://{port}-ws.example.dev',
			'https://{port}--env.eu.example.dev',
			'http://my-vm.example.dev:{port}',
			'https://ide.example.dev/proxy/{port}/'
		]) {
			assert.ok(validPattern(p), p);
		}
	});

	it('refuses anything else', () => {
		for (const p of [
			undefined,
			42,
			'',
			'https://example.dev',
			'https://{port}-{port}.example.dev',
			'ftp://{port}.example.dev',
			'javascript:{port}',
			'https://user:pw@{port}.example.dev',
			'https://example.dev/?port={port}',
			'https://example.dev/#{port}',
			'{port}.example.dev',
			`https://${'a'.repeat(400)}{port}.example.dev`
		]) {
			assert.ok(!validPattern(p), String(p));
		}
	});
});

describe('publicPortUrl', () => {
	it('keeps the path, query and fragment after the pattern’s own path', () => {
		assert.equal(
			publicPortUrl('http://localhost:8080/a/b?c=1#d', 'https://ide.example.dev/proxy/{port}/'),
			'https://ide.example.dev/proxy/8080/a/b?c=1#d'
		);
		assert.equal(
			publicPortUrl('http://LOCALHOST/', 'http://my-vm.example.dev:{port}'),
			'http://my-vm.example.dev/'
		);
		assert.equal(
			publicPortUrl('http://localhost:5173/', 'http://my-vm.example.dev:{port}'),
			'http://my-vm.example.dev:5173/'
		);
	});

	it('leaves addresses that are not http on this computer alone', () => {
		for (const raw of ['https://localhost:5173/', 'http://example.com:5173/', 'not a url']) {
			assert.equal(publicPortUrl(raw, 'https://{port}-ws.example.dev'), null, raw);
		}
		assert.equal(publicPortUrl('http://localhost:5173/', 'https://example.dev'), null);
	});
});
