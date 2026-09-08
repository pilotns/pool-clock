const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { configure } = require('../scripts/configure');
const { defaults } = require('../sensor-service');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pool-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, 'config', 'settings.json');
}
function answers(values) {
  return async () => {
    assert.ok(values.length, 'Unexpected prompt');
    return values.shift();
  };
}
test('terminal setup creates a normalized configuration before first GUI launch', async t => {
  const target = await fixture(t);
  assert.equal(await configure(target, answers(['192.168.1.10', 'outside', '', 'inside', '', 'waterTemp', '', 'moisture', '', 'y'])), true);
  const saved = JSON.parse(await fs.readFile(target, 'utf8'));
  assert.equal(saved.server, 'http://192.168.1.10:8080');
  assert.deepEqual(saved.sensors.water, { endpoint: 'waterTemp', mode: 'sse' });
  assert.equal(saved.sensors.air.mode, 'http');
});
test('terminal edits preserve display settings and support clearing an item', async t => {
  const target = await fixture(t);
  await fs.mkdir(path.dirname(target));
  const original = { ...defaults(), sensorTextSize: 64, sensorTextWeight: 700, secondPulse: false };
  original.sensors.water.endpoint = 'waterTemp';
  await fs.writeFile(target, JSON.stringify(original));
  await configure(target, answers(['', '', '', '', '', '-', '', '', '', 'yes']));
  const saved = JSON.parse(await fs.readFile(target, 'utf8'));
  original.sensors.water.endpoint = '';
  assert.deepEqual(saved, original);
});
test('cancel and malformed existing files never overwrite configuration', async t => {
  const target = await fixture(t);
  await configure(target, answers(['', '', '', '', '', '', '', '', '', 'n']));
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await fs.mkdir(path.dirname(target));
  await fs.writeFile(target, '{broken');
  await assert.rejects(configure(target, answers([])), SyntaxError);
  assert.equal(await fs.readFile(target, 'utf8'), '{broken');
});
