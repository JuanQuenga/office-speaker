const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  powerMonitor,
  shell,
} = require("electron");
const { execFile, execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const ENGINE_EXE = isWin ? "speaker-engine.exe" : "speaker-engine";

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------- settings

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function defaultSpeakerName() {
  if (isMac) {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
      if (name) return name;
    } catch {}
  }
  return "Office Speaker";
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {}
  const settings = {
    name: defaultSpeakerName(),
    output: "",
    bitrate: "320",
    volume: 50,
    normalize: true,
    deviceId: crypto.randomBytes(20).toString("hex"),
    firstRun: true,
    ...saved,
  };
  if (!saved.deviceId) saveSettings(settings);
  return settings;
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// ---------------------------------------------------------------- state

let settings;
let tray = null;
let win = null;
let quitting = false;

const state = {
  status: "starting", // starting | ready | connecting | connected | offline | error
  message: "",
  client: "",
  playing: false,
  track: null,
  volume: null,
};

function publicState() {
  return {
    ...state,
    settings: {
      name: settings.name,
      output: settings.output,
      bitrate: settings.bitrate,
      volume: settings.volume,
      normalize: settings.normalize,
      openAtLogin: getOpenAtLogin(),
    },
    packaged: app.isPackaged,
    version: app.getVersion(),
  };
}

function update(patch) {
  Object.assign(state, patch);
  win?.webContents.send("state", publicState());
  refreshTray();
}

// ---------------------------------------------------------------- engine

let engine = null;
let restartTimer = null;
let restartDelay = 1000;
const engineLog = [];

function enginePath() {
  // Dev/testing hook: run a different engine build.
  if (!app.isPackaged && process.env.OFFICE_SPEAKER_ENGINE) return process.env.OFFICE_SPEAKER_ENGINE;
  return app.isPackaged
    ? path.join(process.resourcesPath, "engine", ENGINE_EXE)
    : path.join(__dirname, "..", "engine", "dist", ENGINE_EXE);
}

function startEngine() {
  clearTimeout(restartTimer);
  const args = [
    "--name", settings.name,
    "--device-id", settings.deviceId,
    "--output", settings.output,
    "--bitrate", settings.bitrate,
    "--volume", String(settings.volume),
  ];
  if (!settings.normalize) args.push("--no-normalize");

  update({ status: "starting", message: "", client: "", playing: false, track: null });

  let child;
  try {
    child = spawn(enginePath(), args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    update({ status: "error", message: `Could not start the speaker engine: ${error.message}` });
    return;
  }
  engine = child;

  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    // Ignore stragglers from an engine we're already replacing.
    if (engine !== child) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    handleEngineEvent(event);
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => {
    engineLog.push(line);
    if (engineLog.length > 300) engineLog.shift();
  });

  child.on("error", (error) => {
    update({ status: "error", message: `Speaker engine failed: ${error.message}` });
  });
  child.on("exit", (code) => {
    if (engine === child) engine = null;
    if (quitting || child.intentionalStop) return;
    update({ status: "error", message: state.message || `Speaker engine stopped (code ${code}). Restarting…` });
    restartTimer = setTimeout(startEngine, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 30000);
  });
}

function handleEngineEvent(event) {
  switch (event.type) {
    case "ready":
      restartDelay = 1000;
      update({ status: "ready", message: "" });
      break;
    case "discovery_error":
      update({ status: "offline", message: "Waiting for a network connection…" });
      break;
    case "connecting":
      update({ status: "connecting" });
      break;
    case "session":
      update({ status: "connected", message: "" });
      break;
    case "client":
      update({ client: event.name || event.model || "" });
      break;
    case "track":
      update({ track: event });
      break;
    case "playing":
      update({ status: "connected", playing: true });
      break;
    case "paused":
    case "stopped":
      update({ playing: false });
      break;
    case "volume":
      update({ volume: event.percent });
      rememberVolume(event.percent);
      break;
    case "session_ended":
    case "idle":
      update({ status: "ready", client: "", playing: false, track: null, volume: null });
      break;
    case "error":
    case "fatal":
      update({ message: event.message });
      if (event.type === "fatal") update({ status: "error" });
      break;
  }
}

// Start at the last volume after a restart instead of jumping back to the default.
let volumeSaveTimer = null;
function rememberVolume(percent) {
  if (typeof percent !== "number" || percent === settings.volume) return;
  settings.volume = percent;
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(() => saveSettings(settings), 1500);
}

function sendCommand(command) {
  if (engine?.stdin.writable) engine.stdin.write(`${command}\n`);
}

function stopEngine() {
  const child = engine;
  engine = null;
  if (!child) return Promise.resolve();
  child.intentionalStop = true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve();
    }, 4000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    // Closing stdin asks the engine to leave Spotify and the network cleanly.
    child.stdin.end();
  });
}

async function restartEngine() {
  if (quitting) return;
  await stopEngine();
  startEngine();
}

function listOutputs() {
  return new Promise((resolve) => {
    execFile(enginePath(), ["--list-outputs"], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
      if (error) return resolve({ default: null, outputs: [] });
      try {
        resolve(JSON.parse(stdout.trim().split("\n").pop()));
      } catch {
        resolve({ default: null, outputs: [] });
      }
    });
  });
}

// ---------------------------------------------------------------- login item

function getOpenAtLogin() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings().openAtLogin;
}

function setOpenAtLogin(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ["--hidden"] });
}

// ---------------------------------------------------------------- UI

function statusLine() {
  switch (state.status) {
    case "starting":
      return "Starting…";
    case "ready":
      return `Ready as “${settings.name}”`;
    case "connecting":
      return "Connecting to Spotify…";
    case "connected":
      if (state.track) return `${state.playing ? "▶" : "❚❚"} ${state.track.title} — ${state.track.artist}`;
      return state.client ? `Connected: ${state.client}` : "Connected";
    case "offline":
      return "Waiting for network…";
    default:
      return state.message || "Something went wrong";
  }
}

function trayImage() {
  if (isMac) {
    const image = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "trayTemplate.png"));
    image.setTemplateImage(true);
    return image;
  }
  return nativeImage.createFromPath(
    path.join(__dirname, "..", "assets", isWin ? "tray.ico" : "tray-color.png"),
  );
}

function refreshTray() {
  if (!tray) return;
  const connected = state.status === "connected";
  const template = [
    { label: statusLine(), enabled: false },
    ...(connected && state.client ? [{ label: `From ${state.client}`, enabled: false }] : []),
    { type: "separator" },
    {
      label: state.playing ? "Pause" : "Play",
      enabled: connected,
      click: () => sendCommand(state.playing ? "pause" : "play"),
    },
    { label: "Next track", enabled: connected, click: () => sendCommand("next") },
    { label: "Disconnect listener", enabled: connected, click: () => sendCommand("disconnect") },
    { type: "separator" },
    { label: "Open Office Speaker…", click: showWindow },
    {
      label: "Start at login",
      type: "checkbox",
      enabled: app.isPackaged,
      checked: getOpenAtLogin(),
      click: (item) => {
        setOpenAtLogin(item.checked);
        update({});
      },
    },
    { type: "separator" },
    { label: "Quit Office Speaker", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setToolTip(`Office Speaker — ${statusLine()}`);
}

function createTray() {
  tray = new Tray(trayImage());
  if (!isMac) tray.on("click", showWindow);
  refreshTray();
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 940,
    height: 680,
    minWidth: 800,
    minHeight: 560,
    useContentSize: true,
    fullscreenable: false,
    title: "Office Speaker",
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon-256.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "..", "dist-renderer", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.on("closed", () => {
    win = null;
    if (isMac) app.dock?.hide();
  });
  if (isMac) app.dock?.show();
}

// ---------------------------------------------------------------- IPC

ipcMain.handle("get-state", () => publicState());
ipcMain.handle("list-outputs", () => listOutputs());
ipcMain.handle("command", (_event, command) => {
  if (["play", "pause", "next", "prev", "disconnect"].includes(command)) sendCommand(command);
});
ipcMain.handle("set-volume", (_event, percent) => {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent))));
  if (Number.isFinite(value)) sendCommand(`volume ${value}`);
});
ipcMain.handle("save-settings", async (_event, next) => {
  const name = String(next.name ?? "").trim().slice(0, 60);
  if (!name) return { ok: false, error: "Give the speaker a name." };
  const engineChanged =
    name !== settings.name ||
    next.output !== settings.output ||
    next.bitrate !== settings.bitrate ||
    Boolean(next.normalize) !== settings.normalize;

  settings = {
    ...settings,
    name,
    output: String(next.output ?? ""),
    bitrate: ["96", "160", "320"].includes(next.bitrate) ? next.bitrate : "320",
    normalize: Boolean(next.normalize),
  };
  saveSettings(settings);
  if (typeof next.openAtLogin === "boolean") setOpenAtLogin(next.openAtLogin);
  if (engineChanged) await restartEngine();
  else update({});
  return { ok: true };
});
ipcMain.handle("copy-logs", () => {
  require("electron").clipboard.writeText(engineLog.join("\n"));
});

// ---------------------------------------------------------------- lifecycle

app.on("second-instance", showWindow);
app.on("activate", showWindow);
app.on("window-all-closed", () => {
  // Keep running in the menu bar / tray.
});

app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();
  stopEngine().finally(() => app.exit(0));
});

app.whenReady().then(() => {
  if (isMac) app.dock?.hide();
  settings = loadSettings();
  const firstRun = settings.firstRun;
  if (firstRun) {
    // A speaker should come back by itself after a reboot.
    setOpenAtLogin(true);
    settings.firstRun = false;
    saveSettings(settings);
  }
  createTray();
  startEngine();

  const launchedHidden =
    process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAsHidden;
  if (firstRun || !launchedHidden) showWindow();

  // Network sockets and Spotify sessions don't survive sleep well; start fresh.
  powerMonitor.on("resume", () => setTimeout(restartEngine, 3000));
});
