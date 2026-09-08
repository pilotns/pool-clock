#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createInterface } = require('node:readline/promises');
const { defaults, validateSettings } = require('../sensor-service');

function settingsPath() {
  const base = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'pool-clock', 'settings.json');
}

async function configure(target, ask) {
  let settings;
  try {
    settings = validateSettings(JSON.parse(await fs.readFile(target, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settings = defaults();
  }
  async function field(label, current, update) {
    while (true) {
      const answer = (await ask(`${label} [${current || 'not configured'}]: `)).trim();
      const next = structuredClone(settings);
      update(next, answer === '' ? current : answer === '-' ? '' : answer);
      try {
        settings = validateSettings(next);
        return;
      } catch (error) {
        console.error(error.message);
      }
    }
  }
  await field('Server address (default port 8080)', settings.server, (next, value) => { next.server = value; });
  for (const [id, sensor] of Object.entries(settings.sensors)) {
    await field(`${id}: item name`, sensor.endpoint, (next, value) => { next.sensors[id].endpoint = value; });
    await field(`${id}: mode (http/sse)`, sensor.mode, (next, value) => { next.sensors[id].mode = value.toLowerCase(); });
  }
  const confirmation = (await ask('Save settings? [y/N]: ')).trim().toLowerCase();
  if (!['y', 'yes'].includes(confirmation)) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return true;
}

async function main() {
  if (process.getuid?.() === 0) throw new Error('Run as the kiosk user without sudo.');
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal (SSH with a TTY).');
  const target = settingsPath();
  console.log(`Settings file: ${target}\nStop the kiosk before editing. Enter keeps a value; - clears an address or item.\nDisplay settings are preserved. Press Ctrl+C to abort without saving.`);
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const saved = await configure(target, prompt => terminal.question(prompt));
    console.log(saved ? 'Settings saved. Start the kiosk to apply them.' : 'Cancelled. Settings were not changed.');
  } finally {
    terminal.close();
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { configure, settingsPath };
