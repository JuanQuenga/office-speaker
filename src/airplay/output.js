// Plays AirPlay PCM through the computer's default output.
//
// Electron's main process has no audio API, so a hidden window runs a Web
// Audio worklet with a jitter buffer. PCM reaches it over a MessagePort.

"use strict";

const { BrowserWindow, MessageChannelMain } = require("electron");
const path = require("node:path");

class AudioOutput {
  constructor({ log = () => {}, onStats = () => {}, onRadio = () => {} } = {}) {
    this.log = log;
    this.onStats = onStats;
    this.onRadio = onRadio;
    this.window = null;
    this.port = null;
    this.ready = null;
    this.gain = 1;
  }

  open() {
    this.ready ??= new Promise((resolve) => {
      const win = new BrowserWindow({
        show: false,
        width: 100,
        height: 100,
        webPreferences: {
          preload: path.join(__dirname, "player-preload.js"),
          contextIsolation: true,
          sandbox: true,
          // Keep audio running while the window is hidden.
          backgroundThrottling: false,
          autoplayPolicy: "no-user-gesture-required",
        },
      });
      this.window = win;
      win.on("closed", () => {
        if (this.window === win) {
          this.window = null;
          this.port = null;
          this.ready = null;
        }
      });
      win.webContents.on("render-process-gone", (_event, details) => {
        this.log(`airplay: audio output crashed (${details.reason})`);
        win.destroy();
      });
      win.webContents.once("did-finish-load", () => {
        const { port1, port2 } = new MessageChannelMain();
        port1.on("message", (event) => {
          if (event.data?.type === "stats") this.onStats(event.data);
          if (event.data?.type === "radio") this.onRadio(event.data);
          if (event.data?.type === "error") this.log(`airplay: audio output error: ${event.data.message}`);
        });
        port1.start();
        win.webContents.postMessage("audio-port", null, [port2]);
        this.port = port1;
        this.post({ type: "gain", value: this.gain });
        resolve();
      });
      win.loadFile(path.join(__dirname, "player.html"));
    });
    return this.ready;
  }

  post(message) {
    this.port?.postMessage(message);
  }

  /** @param {Int16Array} pcm interleaved stereo, 44.1 kHz */
  write(pcm) {
    if (this.port) this.post({ type: "pcm", pcm });
    else this.open();
  }

  flush() {
    this.post({ type: "flush" });
  }

  setGain(gain) {
    this.gain = gain;
    this.post({ type: "gain", value: gain });
  }

  async playRadio(url, volume) {
    await this.open();
    this.post({ type: "radio-play", url, volume });
  }

  stopRadio() {
    this.post({ type: "radio-stop" });
  }

  setRadioVolume(volume) {
    this.post({ type: "radio-volume", value: volume });
  }

  close() {
    const win = this.window;
    this.window = null;
    this.port = null;
    this.ready = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}

/** AirPlay volume is in dB: -30 (quietest) to 0, with -144 meaning mute. */
function gainFromDb(db) {
  if (db <= -30) return db <= -144 ? 0 : 0.03;
  return Math.pow(10, db / 20);
}

function percentFromDb(db) {
  if (db <= -144) return 0;
  return Math.round(Math.max(0, Math.min(1, (db + 30) / 30)) * 100);
}

function dbFromPercent(percent) {
  if (percent <= 0) return -144;
  return -30 + (30 * Math.min(100, percent)) / 100;
}

module.exports = { AudioOutput, gainFromDb, percentFromDb, dbFromPercent };
