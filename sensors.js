const { normalizeItem, TIMING, TEXT_SIZE, TEXT_WEIGHT } = window.sensorConfig;
const statuses = { unconfigured: 'not configured', connecting: 'connecting…', waiting: 'waiting for data', offline: '', invalid: 'no data', ok: '' };
const sensorElements = new Map([...document.querySelectorAll('[data-sensor]')].map(element => [element.dataset.sensor, {
  label: element.getAttribute('aria-label'),
  value: element.querySelector('.sensor-value'),
  status: element.querySelector('.sensor-status'),
}]));
const dialog = document.getElementById('settings-dialog');
const form = document.getElementById('settings-form');
const address = document.getElementById('settings-address');
const mode = document.getElementById('settings-mode');
const errorElement = document.getElementById('settings-error');
const titleElement = document.getElementById('settings-title');
const labelElement = document.getElementById('settings-label');
const hintElement = document.getElementById('settings-hint');
const modeField = document.getElementById('mode-field');
const displayControls = [
  { key: 'sensorTextSize', id: 'text-size', rule: TEXT_SIZE, unit: 'px', suffix: ' px' },
  { key: 'sensorTextWeight', id: 'text-weight', rule: TEXT_WEIGHT, unit: '', suffix: '' },
  { key: 'secondPulse', id: 'second-pulse', rule: { default: true }, checkbox: true },
].map(control => ({
  ...control,
  field: document.getElementById(`${control.id}-field`),
  input: document.getElementById(`settings-${control.id}`),
  output: document.getElementById(`${control.id}-value`),
  saved: control.rule.default,
}));
function displayValue(control) {
  if (control.checkbox) return control.input.checked;
  const value = Number(control.input.value);
  return control.rule.values ? control.rule.values[value] : value;
}
function applyDisplayValue(control, value) {
  if (control.checkbox) {
    document.documentElement.classList.toggle('second-pulse-disabled', !value);
    return;
  }
  document.documentElement.style.setProperty(`--sensor-${control.id}`, `${value}${control.unit}`);
  const label = control.rule.labels?.[value] ?? `${value}${control.suffix}`;
  control.output.value = label;
  control.input.setAttribute('aria-valuetext', label);
}
function loadDisplaySettings(loaded) {
  for (const control of displayControls) {
    control.saved = loaded[control.key] ?? control.rule.default;
    if (control.checkbox) control.input.checked = control.saved;
    else control.input.value = control.rule.values ? control.rule.values.indexOf(control.saved) : control.saved;
    applyDisplayValue(control, control.saved);
  }
}
function setDisplayControlsDisabled(disabled) {
  for (const control of displayControls) control.input.disabled = disabled;
}
for (const control of displayControls) {
  if (!control.checkbox) {
    const positions = control.rule.values;
    Object.assign(control.input, positions
      ? { min: 0, max: positions.length - 1, step: 1 }
      : { min: control.rule.min, max: control.rule.max, step: control.rule.step ?? 1 });
  }
  control.input.addEventListener(control.checkbox ? 'change' : 'input', () => applyDisplayValue(control, displayValue(control)));
}
const weightStops = document.getElementById('weight-stops');
for (const weight of TEXT_WEIGHT.values) {
  const label = document.createElement('span');
  label.textContent = TEXT_WEIGHT.labels[weight];
  weightStops.appendChild(label);
}
function restoreDisplaySettings() {
  for (const control of displayControls) applyDisplayValue(control, control.saved);
}
dialog.addEventListener('close', () => {
  if (!dialog.open) restoreDisplaySettings();
});
window.pool.getSettings().then(loaded => {
  if (!dialog.open) loadDisplaySettings(loaded);
}).catch(() => {
  if (!dialog.open) loadDisplaySettings({});
});
const saveButton = document.getElementById('settings-save');
const logo = document.querySelector('.logo');
const offlineSensors = new Set();
const connectedStreams = new Set();
let settings;
let editing;
let saving = false;

// Dialogs restore focus to their opener; show its outline only for keyboard navigation.
document.addEventListener('pointerdown', () => {
  document.documentElement.classList.remove('keyboard-navigation');
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Tab') document.documentElement.classList.add('keyboard-navigation');
}, true);

function renderSettingsFields() {
  const server = editing === 'server';
  titleElement.textContent = server ? 'Display settings' : `Sensor: ${sensorElements.get(editing).label}`;
  labelElement.textContent = server ? 'Server address' : 'Item name';
  modeField.hidden = server;
  for (const control of displayControls) control.field.hidden = !server;
  address.placeholder = server ? '192.168.1.10:8080' : 'waterTemperature';
  if (server) {
    hintElement.textContent = 'Local server address, e.g. 192.168.1.10. Default port: 8080. Leave blank to disable connections.';
  } else {
    const behavior = mode.value === 'sse'
      ? 'The subscription path is added automatically.'
      : `Updates at startup, on SSE changes and every ${TIMING.httpRefresh / 1000} seconds as a fallback.`;
    hintElement.textContent = `Enter only the item name, e.g. waterTemperature. ${behavior} Leave blank to disable this sensor.`;
  }
}
mode.addEventListener('change', () => {
  address.value = normalizeItem(address.value);
  renderSettingsFields();
});

async function openSettings(id) {
  if (dialog.open) return;
  editing = id;
  settings = undefined;
  address.value = '';
  errorElement.textContent = '';
  saveButton.disabled = true;
  setDisplayControlsDisabled(true);
  renderSettingsFields();
  dialog.showModal();
  try {
    const loaded = await window.pool.getSettings();
    if (!dialog.open || editing !== id) return;
    settings = loaded;
    loadDisplaySettings(settings);
    setDisplayControlsDisabled(false);
    const server = id === 'server';
    address.value = server ? settings.server : normalizeItem(settings.sensors[id].endpoint);
    if (!server) mode.value = settings.sensors[id].mode;
    renderSettingsFields();
    saveButton.disabled = false;
    address.focus();
  } catch { errorElement.textContent = 'Unable to load settings.'; }
}
for (const control of document.querySelectorAll('[data-settings]')) {
  control.addEventListener('click', () => openSettings(control.dataset.settings));
  if (control.tagName.toLowerCase() === 'image') {
    control.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openSettings('server'); }
    });
  }
}
document.getElementById('settings-cancel').addEventListener('click', () => {
  if (!saving) {
    restoreDisplaySettings();
    dialog.close();
  }
});
dialog.addEventListener('cancel', event => {
  if (saving) event.preventDefault();
  else restoreDisplaySettings();
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || !settings) return;
  const next = structuredClone(settings);
  if (editing === 'server') {
    next.server = address.value;
    for (const control of displayControls) next[control.key] = displayValue(control);
  }
  else next.sensors[editing] = { endpoint: address.value, mode: mode.value };
  saving = true;
  saveButton.disabled = true;
  errorElement.textContent = '';
  try {
    settings = await window.pool.saveSettings(next);
    loadDisplaySettings(settings);
    dialog.close();
  } catch (error) {
    errorElement.textContent = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  } finally {
    saving = false;
    saveButton.disabled = false;
  }
});
window.pool.onSensorUpdate(({ id, status, value }) => {
  const element = sensorElements.get(id);
  if (!element) return;
  if (status === 'offline') offlineSensors.add(id);
  else offlineSensors.delete(id);
  // Only 'waiting' confirms an accepted SSE connection, before the first reading.
  if (status === 'waiting') connectedStreams.add(id);
  else if (['offline', 'unconfigured', 'connecting'].includes(status)) connectedStreams.delete(id);
  const offline = connectedStreams.size === 0 || offlineSensors.size > 0;
  logo.classList.toggle('logo--offline', offline);
  logo.setAttribute('aria-label', offline ? 'Server settings: SSE disconnected or sensor connection lost' : 'Server settings');
  if (status === 'ok') element.value.textContent = value;
  else if (status === 'unconfigured' || status === 'connecting') element.value.textContent = '—';
  element.status.textContent = statuses[status] ?? statuses.invalid;
  element.status.dataset.status = status;
});
