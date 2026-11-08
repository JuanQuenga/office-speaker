const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("speaker", {
  getState: () => ipcRenderer.invoke("get-state"),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("state", listener);
    return () => ipcRenderer.removeListener("state", listener);
  },
  listOutputs: () => ipcRenderer.invoke("list-outputs"),
  command: (command) => ipcRenderer.invoke("command", command),
  setVolume: (percent) => ipcRenderer.invoke("set-volume", percent),
  saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
  copyLogs: () => ipcRenderer.invoke("copy-logs"),
});
