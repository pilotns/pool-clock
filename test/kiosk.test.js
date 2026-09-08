const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { defaults } = require('../sensor-service');

async function launch(kiosk) {
  let ready, options, loaded;
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  const electron = {
    app: { whenReady: () => ({ then: callback => { ready = callback(); } }), on() {}, getPath: () => '/tmp/pool-kiosk-test' },
    ipcMain: { handle() {}, on() {} },
    screen: { getPrimaryDisplay: () => ({ bounds }) },
    BrowserWindow: class {
      constructor(input) {
        options = input;
        this.webContents = { setWindowOpenHandler() {}, on() {} };
      }
      loadFile(file) { loaded = file; }
    },
  };
  const project = path.join(__dirname, '..');
  const context = {
    __dirname: project, console, process: { argv: kiosk ? ['electron', '.', '--kiosk'] : ['electron', '.'] },
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'node:fs/promises') return { readFile: async () => JSON.stringify(defaults()) };
      if (name === './sensor-service') return require('../sensor-service');
      return require(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(project, 'main.js'), 'utf8'), context);
  await ready;
  return { options, loaded, bounds };
}

test('kiosk launch sizes the window explicitly for a screen without a window manager', async () => {
  const { options, bounds, loaded } = await launch(true);
  for (const key of ['x', 'y', 'width', 'height']) assert.equal(options[key], bounds[key]);
  assert.equal(options.kiosk, true);
  assert.equal(options.fullscreen, true);
  assert.equal(options.frame, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.ok(loaded.endsWith('index.html'));
});

test('normal desktop launch remains outside kiosk mode', async () => {
  const { options } = await launch(false);
  assert.equal(options.kiosk, false);
  assert.equal(options.width, undefined);
  assert.equal(options.fullscreen, true);
});
