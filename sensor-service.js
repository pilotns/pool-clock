const http = require('node:http');
const https = require('node:https');
const { TEXT_SIZE, TEXT_WEIGHT, TIMING, normalizeItem, sensorPath } = require('./sensor-config');
const MAX_RESPONSE_SIZE = 1024 * 1024;
const IDS = ['outdoor', 'air', 'water', 'humidity'];
const defaults = () => ({ server: '', secondPulse: true, sensorTextSize: TEXT_SIZE.default, sensorTextWeight: TEXT_WEIGHT.default, sensors: Object.fromEntries(IDS.map(id => [id, { endpoint: '', mode: id === 'water' ? 'sse' : 'http' }])) });

function validateSettings(input) {
  const result = defaults();
  const secondPulse = input?.secondPulse ?? true;
  if (typeof secondPulse !== 'boolean') throw new Error('Second pulse must be enabled or disabled.');
  result.secondPulse = secondPulse;
  const size = input?.sensorTextSize ?? TEXT_SIZE.default;
  if (!Number.isInteger(size) || size < TEXT_SIZE.min || size > TEXT_SIZE.max) {
    throw new Error(`Sensor text size must be between ${TEXT_SIZE.min} and ${TEXT_SIZE.max} px.`);
  }
  result.sensorTextSize = size;
  const weight = input?.sensorTextWeight ?? TEXT_WEIGHT.default;
  if (!Number.isInteger(weight) || weight < TEXT_WEIGHT.min || weight > TEXT_WEIGHT.max || weight % TEXT_WEIGHT.step !== 0) {
    throw new Error('Sensor font weight must be from 100 to 900 in steps of 100.');
  }
  result.sensorTextWeight = TEXT_WEIGHT.values.reduce((nearest, candidate) =>
    Math.abs(candidate - weight) < Math.abs(nearest - weight) ? candidate : nearest);
  if (typeof input?.server !== 'string') throw new Error('Enter a server address.');
  if (input.server.trim()) {
    let address = input.server.trim();
    if (!/^https?:\/\//i.test(address)) address = `http://${address}`;
    let url;
    try { url = new URL(address); } catch { throw new Error('Invalid server address.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Enter only a server address and port, without a path.');
    }
    // URL removes explicit standard ports; preserve them instead of replacing with 8080.
    const authority = address.split('/')[2];
    const explicitPort = authority.match(/:(\d+)$/)?.[1];
    const port = explicitPort ? String(Number(explicitPort)) : '8080';
    if (Number(port) < 1 || Number(port) > 65535) throw new Error('Port must be between 1 and 65535.');
    result.server = `${url.protocol}//${url.hostname}:${port}`;
  }
  for (const id of IDS) {
    const sensor = input.sensors?.[id];
    if (typeof sensor?.endpoint !== 'string' || !['http', 'sse'].includes(sensor.mode)) throw new Error('Invalid sensor settings.');
    const endpoint = normalizeItem(sensor.endpoint);
    if (endpoint && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(endpoint)) {
      throw new Error('Use letters, digits and underscores for the item name; start with a letter or underscore.');
    }
    result.sensors[id] = { endpoint, mode: sensor.mode };
  }
  return result;
}

function numericValue(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function parseValue(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  if (data && typeof data === 'object') {
    if (data.type && !['ItemStateEvent', 'ItemStateChangedEvent'].includes(data.type) && data.payload != null) return undefined;
    if (data.payload != null) {
      try { data = typeof data.payload === 'string' ? JSON.parse(data.payload) : data.payload; } catch { return null; }
    }
    data = data?.value ?? data?.state;
  }
  return numericValue(data);
}
function formatValue(value, id) {
  if (!Number.isFinite(value) || (id === 'humidity' && (value < 0 || value > 100))) return null;
  const rounded = Math.round(value * 10) / 10;
  return id === 'humidity' ? `${rounded}%` : `${rounded > 0 ? '+' : ''}${rounded}°`;
}

function startSensors(settings, publish) {
  const httpRefreshers = [];
  const stops = IDS.map(id => {
    const config = settings.sensors[id];
    let stopped = false, request, timer, refreshTimer;
    let active = false, pendingRefresh = false;
    let lastSseValue;
    const emit = (status, value = null) => { if (!stopped) publish({ id, status, value }); };
    if (!settings.server || !config.endpoint) { emit('unconfigured'); return () => {}; }
    const url = new URL(sensorPath(config), settings.server);
    const transport = url.protocol === 'https:' ? https : http;
    const acceptValue = raw => {
      const value = parseValue(raw);
      if (value === undefined) return;
      const formatted = formatValue(value, id);
      emit(formatted === null ? 'invalid' : 'ok', formatted);
      if (config.mode === 'sse' && formatted !== null) {
        const changed = lastSseValue !== undefined && value !== lastSseValue;
        lastSseValue = value;
        if (changed) httpRefreshers.forEach(refresh => refresh());
      }
    };
    emit('connecting');
    const connect = () => {
      if (stopped || active) return;
      timer = undefined;
      clearTimeout(refreshTimer);
      refreshTimer = undefined;
      const startedAt = Date.now();
      active = true;
      pendingRefresh = false;
      let finished = false;
      const finish = failed => {
        if (finished || stopped) return;
        finished = true;
        if (failed) emit('offline');
        request?.destroy();
        active = false;
        if (failed) timer = setTimeout(connect, TIMING.retry);
        else if (pendingRefresh) connect();
        else if (config.mode === 'http') {
          refreshTimer = setTimeout(connect, Math.max(0, TIMING.httpRefresh - (Date.now() - startedAt)));
        }
      };
      const fail = () => finish(true);
      request = transport.get(url, { headers: { Accept: config.mode === 'sse' ? 'text/event-stream' : 'application/json, text/plain' } }, response => {
        if (response.statusCode !== 200) { response.resume(); finish(true); return; }
        response.setEncoding('utf8');
        if (config.mode === 'sse') {
          if (!response.headers['content-type']?.includes('text/event-stream')) { finish(true); return; }
          emit('waiting');
          let buffer = '', lines = [];
          response.on('data', chunk => {
            buffer += chunk;
            if (buffer.length > MAX_RESPONSE_SIZE) { finish(true); return; }
            let end;
            while ((end = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, end).replace(/\r$/, '');
              buffer = buffer.slice(end + 1);
              if (line === '') {
                if (lines.length) acceptValue(lines.join('\n'));
                lines = [];
              } else if (line.startsWith('data:')) {
                lines.push(line.slice(5).replace(/^ /, ''));
                if (lines.join('\n').length > MAX_RESPONSE_SIZE) { finish(true); return; }
              }
            }
          });
          response.on('end', fail);
        } else {
          let body = '';
          response.on('data', chunk => { body += chunk; if (body.length > MAX_RESPONSE_SIZE) finish(true); });
          response.on('end', () => { if (!finished) { acceptValue(body); finish(false); } });
        }
        response.on('error', fail);
        response.on('aborted', fail);
      });
      request.setTimeout(config.mode === 'sse' ? TIMING.sseTimeout : TIMING.httpTimeout, fail);
      request.on('error', fail);
    };
    if (config.mode === 'http') {
      httpRefreshers.push(() => {
        if (stopped) return;
        // Keep one follow-up request if the SSE value changes during a request.
        if (active) pendingRefresh = true;
        else if (!timer) connect();
      });
    }
    connect();
    return () => { stopped = true; clearTimeout(timer); clearTimeout(refreshTimer); request?.destroy(); };
  });
  return () => stops.forEach(stop => stop());
}
module.exports = { defaults, validateSettings, numericValue, parseValue, formatValue, startSensors };
