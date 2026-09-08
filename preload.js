const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pool', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  onSensorUpdate: callback => {
    ipcRenderer.on('sensor:update', (_event, data) => callback(data));
    ipcRenderer.send('sensors:start');
  },
});
