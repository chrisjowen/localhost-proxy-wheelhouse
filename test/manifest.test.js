import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import plugin from '../wheelhouse/server/index.js';

const manifest = JSON.parse(
	readFileSync(new URL('../.wheelhouse-plugin/plugin.json', import.meta.url), 'utf8')
);
// A copy of Wheelhouse's packages/plugin-sdk/plugin.schema.json.
const schema = JSON.parse(readFileSync(new URL('./plugin.schema.json', import.meta.url), 'utf8'));

describe('the manifest', () => {
	it('follows the Wheelhouse plugin schema', () => {
		const validate = new Ajv2020({ strict: false }).compile(schema);
		assert.ok(validate(manifest), JSON.stringify(validate.errors));
	});

	it('is off until turned on, and names a server entry that exists', () => {
		assert.equal(manifest.wheelhouse.enabledByDefault, false);
		assert.ok(existsSync(new URL(`../${manifest.wheelhouse.server}`, import.meta.url)));
	});

	it('shows addresses on this computer at {port}.localhost, and answers that name', () => {
		assert.deepEqual(manifest.wheelhouse.addressRewrites, [
			{ id: 'localhost', to: '{port}.localhost' }
		]);
		assert.deepEqual(manifest.wheelhouse.hostRoutes, [{ id: 'proxy', host: '{port}.localhost' }]);
	});

	it('lists exactly what the server entry contributes', () => {
		assert.deepEqual(plugin.providers, []);
		assert.deepEqual(plugin.contributions, []);
		assert.deepEqual(manifest.wheelhouse.contributions, []);
		assert.deepEqual(manifest.wheelhouse.services, []);
		assert.deepEqual(
			plugin.hostRoutes.map((r) => r.id),
			manifest.wheelhouse.hostRoutes.map((r) => r.id)
		);
		for (const route of plugin.hostRoutes) {
			assert.equal(typeof route.request, 'function');
			assert.equal(typeof route.upgrade, 'function');
		}
	});

	it('allows no extra ports until the captain lists some', () => {
		assert.deepEqual(manifest.wheelhouse.settings.ports.default, []);
		assert.equal(manifest.wheelhouse.settings.ports.type, 'list');
	});

	it('agrees with package.json on the version', () => {
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		assert.equal(pkg.version, manifest.version);
	});
});
