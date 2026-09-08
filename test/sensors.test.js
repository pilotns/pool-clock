const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { defaults, validateSettings, parseValue, formatValue, startSensors } = require('../sensor-service');

test('server normalization and endpoint validation', () => {
  const input = defaults();
  input.server = '192.168.1.10';
  assert.equal(validateSettings(input).server, 'http://192.168.1.10:8080');
  input.server = 'http://localhost:80';
  assert.equal(validateSettings(input).server, 'http://localhost:80');
  assert.deepEqual(validateSettings(validateSettings(input)), validateSettings(input));
  input.server = 'localhost:8090';
  assert.equal(validateSettings(input).server, 'http://localhost:8090');
  input.sensors.water.mode = 'http';
  input.sensors.water.endpoint = '//external.test/x';
  assert.throws(() => validateSettings(input));
  input.sensors.water.endpoint = '/rest/items/water/state';
  assert.equal(validateSettings(input).sensors.water.endpoint, 'water');
});

test('strict values, signs, humidity and event payloads', () => {
  for (const value of ['Infinity', '28garbage', 'NULL', '', 'null', 'true']) assert.equal(parseValue(value), null);
  assert.equal(formatValue(parseValue('-2.5'), 'water'), '-2.5°');
  assert.equal(formatValue(parseValue('0'), 'water'), '0°');
  assert.equal(formatValue(parseValue('28.56'), 'water'), '+28.6°');
  assert.equal(formatValue(101, 'humidity'), null);
  assert.equal(formatValue(62, 'humidity'), '62%');
  assert.equal(parseValue('{"state":"24.2"}'), 24.2);
  assert.equal(parseValue(JSON.stringify({type:'ItemStateEvent',payload:JSON.stringify({type:'Decimal',value:'25.1'})})), 25.1);
});

test('HTTP polling and fragmented SSE use only configured local server', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/rest/items/waterTemperature/state') { response.end('{"value":27.5}'); return; }
    assert.equal(request.url, '/rest/events?topics=smarthome/items/waterTemperature');
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    response.write('data: {"value":');
    setImmediate(() => response.write('26.5}\r\n\r\n'));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stop = () => {};
  try {
    const settings = defaults();
    settings.server = `http://127.0.0.1:${server.address().port}`;
    settings.sensors.water = {endpoint:'waterTemperature',mode:'http'};
    settings.sensors.air = {endpoint:'waterTemperature',mode:'sse'};
    const received = new Map();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No sensor readings')), 2000);
      stop = startSensors(settings, data => {
        if (data.status === 'ok') received.set(data.id, data.value);
        if (received.size === 2) { clearTimeout(timeout); resolve(); }
      });
    });
    assert.equal(received.get('water'), '+27.5°');
    assert.equal(received.get('air'), '+26.5°');
  } finally { stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('reconnects after timeout and reports restored readings', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, {'Content-Type':'text/event-stream'});
    response.write(`data: ${requests === 1 ? 25 : 26}\n\n`);
    if (requests === 1) setTimeout(() => response.destroy(), 20);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stop = () => {};
  try {
    const settings = defaults();
    settings.server = `http://127.0.0.1:${server.address().port}`;
    settings.sensors.water = {endpoint:'waterTemperature',mode:'sse'};
    const updates = [];
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Reconnect failed')), 8000);
      stop = startSensors(settings, data => {
        if (data.id !== 'water') return;
        updates.push(data);
        if (data.value === '+26°') { clearTimeout(timeout); resolve(); }
      });
    });
    assert.ok(updates.some(data => data.status === 'offline'));
    assert.ok(Date.now() - started >= 5000);
    assert.equal(requests, 2);
  } finally { stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('SSE item names and migration of saved full paths', () => {
  const settings = defaults();
  settings.sensors.water.endpoint = '/rest/events?topics=smarthome/items/waterTemperature';
  const migrated = validateSettings(settings);
  assert.equal(migrated.sensors.water.endpoint, 'waterTemperature');
  assert.deepEqual(validateSettings(migrated), migrated);
  for (const invalid of ['water&topics=*', '../water', 'water temperature', 'water/extra']) {
    settings.sensors.water.endpoint = invalid;
    assert.throws(() => validateSettings(settings));
  }
});

test('HTTP item paths migrate and modes keep the same item', () => {
  const { sensorPath } = require('../sensor-config');
  const settings = defaults();
  settings.sensors.water = { endpoint: '/rest/items/waterTemperature/state', mode: 'http' };
  const migrated = validateSettings(settings);
  assert.equal(migrated.sensors.water.endpoint, 'waterTemperature');
  assert.deepEqual(validateSettings(migrated), migrated);
  assert.equal(sensorPath(migrated.sensors.water), '/rest/items/waterTemperature/state');
  migrated.sensors.water.mode = 'sse';
  assert.equal(sensorPath(migrated.sensors.water), '/rest/events?topics=smarthome/items/waterTemperature');
  for (const invalid of ['water?x=1', '../water', '/rest/items/water/state/extra']) {
    settings.sensors.water.endpoint = invalid;
    assert.throws(() => validateSettings(settings));
  }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for sensor activity');
    await delay(10);
  }
}

test('HTTP updates at startup and SSE changes, without frequent polling or overlapping requests', async () => {
  let stream, heldResponse;
  let requests = 0;
  const updates = [];
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/rest/events?')) {
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: 25.01\n\n');
      return;
    }
    requests++;
    if (requests === 2) heldResponse = response;
    else response.end(String(20 + requests));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stop = () => {};
  try {
    const settings = defaults();
    settings.server = `http://127.0.0.1:${server.address().port}`;
    settings.sensors.water = { endpoint: 'waterTemperature', mode: 'sse' };
    settings.sensors.air = { endpoint: 'airTemperature', mode: 'http' };
    stop = startSensors(settings, data => updates.push(data));
    await until(() => stream && updates.some(data => data.id === 'air' && data.status === 'ok'));
    stream.write('data: "25.010"\n\ndata: "NULL"\n\n');
    await delay(5200);
    assert.equal(requests, 1, 'No refresh before the fallback interval, no refresh for initial/repeated/invalid state');
    // The real value changes even though its displayed rounded value stays the same.
    stream.write('data: 25.02\n\n');
    await until(() => heldResponse);
    stream.write('data: 26\n\ndata: 27\n\n');
    await until(() => updates.some(data => data.id === 'water' && data.value === '+27°'));
    assert.equal(requests, 2, 'Do not overlap HTTP requests');
    heldResponse.end('22');
    await until(() => updates.some(data => data.id === 'air' && data.value === '+23°'));
    assert.equal(requests, 3, 'Coalesce pending changes into one follow-up');
  } finally { stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('failed HTTP request retries after five seconds without another SSE event', async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    if (requests === 1) { response.writeHead(503); response.end(); }
    else response.end('24');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stop = () => {};
  try {
    const settings = defaults();
    settings.server = `http://127.0.0.1:${server.address().port}`;
    settings.sensors.air = { endpoint: 'airTemperature', mode: 'http' };
    const updates = [];
    stop = startSensors(settings, data => updates.push(data));
    await until(() => updates.some(data => data.status === 'offline'));
    await delay(4800);
    assert.equal(requests, 1);
    await until(() => updates.some(data => data.value === '+24°'));
    assert.equal(requests, 2);
  } finally { stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('60-second fallback resets after SSE refresh and stops on shutdown', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const { createRequire } = require('node:module');
  const serviceFile = require.resolve('../sensor-service');
  let now = 0;
  const timers = new Set();
  const context = vm.createContext({
    require: createRequire(serviceFile), module: { exports: {} }, URL,
    Date: { now: () => now },
    setTimeout: (callback, ms) => { const timer = { callback, at: now + ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  });
  vm.runInContext(fs.readFileSync(serviceFile, 'utf8'), context);
  const advance = ms => {
    now += ms;
    for (const timer of [...timers]) {
      if (timer.at <= now) { timers.delete(timer); timer.callback(); }
    }
  };
  let stream, requests = 0, readings = 0;
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/rest/events?')) {
      stream = response;
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: 25\n\n');
    } else { requests++; response.end('24'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let stop = () => {};
  try {
    const settings = defaults();
    settings.server = `http://127.0.0.1:${server.address().port}`;
    settings.sensors.water = { endpoint: 'waterTemperature', mode: 'sse' };
    settings.sensors.air = { endpoint: 'airTemperature', mode: 'http' };
    stop = context.module.exports.startSensors(settings, data => {
      if (data.id === 'air' && data.status === 'ok') readings++;
    });
    await until(() => readings === 1 && stream);
    advance(30000);
    stream.write('data: 26\n\n');
    await until(() => readings === 2);
    advance(30000);
    await delay(30);
    assert.equal(requests, 2, 'Old deadline is cancelled after SSE refresh');
    advance(29999);
    await delay(30);
    assert.equal(requests, 2);
    advance(1);
    await until(() => readings === 3);
    assert.equal(requests, 3, 'Refresh occurs 60 seconds after the SSE-triggered request');
    advance(60000);
    await until(() => readings === 4);
    assert.equal(requests, 4, 'Fallback repeats even while SSE stays unchanged');
    stop();
    assert.equal(timers.size, 0, 'All refresh/retry timers are cancelled on shutdown');
    advance(120000);
    await delay(30);
    assert.equal(requests, 4);
  } finally { stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});


test('text size defaults for older settings and validates saved values', () => {
  const settings = defaults();
  delete settings.sensorTextSize;
  assert.equal(validateSettings(settings).sensorTextSize, 32);
  settings.sensorTextSize = 64;
  assert.equal(validateSettings(settings).sensorTextSize, 64);
  for (const invalid of [0, 97, 32.5, '48']) {
    settings.sensorTextSize = invalid;
    assert.throws(() => validateSettings(settings));
  }
});


test('font weight defaults and validation', () => {
  const settings = defaults();
  delete settings.sensorTextWeight;
  assert.equal(validateSettings(settings).sensorTextWeight, 300);
  settings.sensorTextWeight = 700;
  assert.equal(validateSettings(settings).sensorTextWeight, 700);
  for (const invalid of [0, 1000, 350, '700']) {
    settings.sensorTextWeight = invalid;
    assert.throws(() => validateSettings(settings));
  }
});


test('second pulse defaults and saved disabled state', () => {
  const settings = defaults();
  delete settings.secondPulse;
  assert.equal(validateSettings(settings).secondPulse, true);
  settings.secondPulse = false;
  assert.equal(validateSettings(settings).secondPulse, false);
  settings.secondPulse = 'false';
  assert.throws(() => validateSettings(settings));
});
