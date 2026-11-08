// Hands the PCM MessagePort from the main process to the audio page.
const { ipcRenderer } = require("electron");

ipcRenderer.on("audio-port", (event) => {
  window.postMessage("audio-port", "*", event.ports);
});
