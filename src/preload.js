const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("speaker", {
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  command: (command) => ipcRenderer.invoke("command", command),
  setVolume: (percent) => ipcRenderer.invoke("set-volume", percent),
  seek: (ms) => ipcRenderer.invoke("seek", ms),
  setup: (input) => ipcRenderer.invoke("setup", input),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  openAirPlaySettings: () => ipcRenderer.invoke("open-airplay-settings"),
  radioBrowse: (query) => ipcRenderer.invoke("radio-browse", query),
  radioPlay: (station) => ipcRenderer.invoke("radio-play", station),
  radioStop: () => ipcRenderer.invoke("radio-stop"),
  radioFavorite: (station, on) => ipcRenderer.invoke("radio-favorite", station, on),
  copyLogs: () => ipcRenderer.invoke("copy-logs"),
});
