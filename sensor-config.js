(function (root) {
  const TEXT_SIZE = Object.freeze({ min: 16, max: 96, default: 32 });
  const TEXT_WEIGHT = Object.freeze({ min: 100, max: 900, step: 100, values: Object.freeze([300, 400, 500, 700]), labels: Object.freeze({ 300: 'Light', 400: 'Regular', 500: 'Medium', 700: 'Bold' }), default: 300 });
  const TIMING = Object.freeze({ retry: 5000, httpRefresh: 60000, httpTimeout: 10000, sseTimeout: 90000 });
  const SSE_PREFIX = '/rest/events?topics=smarthome/items/';

  function normalizeItem(value) {
    const input = value.trim();
    if (input.startsWith(SSE_PREFIX)) return input.slice(SSE_PREFIX.length);
    const httpItem = input.match(/^\/rest\/items\/([^/]+)\/state$/);
    return httpItem ? httpItem[1] : input;
  }

  function sensorPath(config) {
    const item = encodeURIComponent(normalizeItem(config.endpoint));
    return config.mode === 'sse' ? SSE_PREFIX + item : `/rest/items/${item}/state`;
  }

  const config = { TEXT_SIZE, TEXT_WEIGHT, TIMING, SSE_PREFIX, normalizeItem, sensorPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = config;
  else root.sensorConfig = config;
})(globalThis);
