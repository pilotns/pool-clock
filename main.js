const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { defaults, validateSettings, startSensors } = require('./sensor-service');
const kioskMode = process.argv.includes('--kiosk');
let settings = defaults();
let stopSensors = () => {};
let win;
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const restartSensors = () => {
  stopSensors();
  stopSensors = startSensors(settings, data => {
    if (win && !win.isDestroyed()) win.webContents.send('sensor:update', data);
  });
};
app.whenReady().then(async () => {
  try { settings = validateSettings(JSON.parse(await fs.readFile(settingsPath(), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') console.error('Cannot load settings:', error); }
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:save', async (_event, input) => {
    const next = validateSettings(input);
    const target = settingsPath();
    await fs.writeFile(`${target}.tmp`, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(`${target}.tmp`, target);
    const connectionChanged = settings.server !== next.server || JSON.stringify(settings.sensors) !== JSON.stringify(next.sensors);
    settings = next;
    if (connectionChanged) restartSensors();
    return settings;
  });
  ipcMain.on('sensors:start', restartSensors);
  win = new BrowserWindow({
    ...(kioskMode ? screen.getPrimaryDisplay().bounds : {}),
    kiosk: kioskMode,
    autoHideMenuBar: kioskMode,
    fullscreen: true,
    frame: false,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.loadFile(path.join(__dirname, 'index.html'));
});
app.on('window-all-closed', () => { stopSensors(); app.quit(); });
