// Tests the version comparison used by the updater (electron itself is stubbed).
import assert from 'node:assert/strict';
import Module from 'node:module';
const orig = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? { app: {}, ipcMain: {}, shell: {}, net: {} } : orig.call(this, req, ...rest); };
const require = Module.createRequire(import.meta.url);
const { compareVersions: c } = require('../lib/updater.js');
assert.equal(c('1.0.1', '1.0.0'), 1);
assert.equal(c('v1.2.0', '1.10.0'), -1);
assert.equal(c('2.0.0', '2.0'), 0);
assert.equal(c('1.0.0', '1.0.0-beta.1'), 1);
assert.equal(c('1.0.0-beta.2', '1.0.0-beta.1'), 1);
assert.equal(c('1.0.0', '1.0.0'), 0);
console.log('updater: 6 version checks passed');
