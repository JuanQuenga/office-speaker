const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  safeStorage,
  shell,
} = require("electron");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { Announcer } = require("./announce");
const { SoloistInstall, defaultRoot, unsupportedReason } = require("./soloist");

const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

const UPDATE_CHECK_MS = 12 * 60 * 60 * 1000;
const FORCE_UPDATE_DAYS = 3; // swap builds even mid-song this close to expiry
const WARN_EXPIRY_DAYS = 14;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------- settings

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const apiKeyPath = () => path.join(app.getPath("userData"), "soloist-api-key");

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
  return { name: defaultSpeakerName(), volume: 50, firstRun: true, consented: false, ...saved };
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

// The Soloist API key is a personal credential: keep it encrypted with the OS keychain.
function readApiKey() {
  try {
    const raw = fs.readFileSync(apiKeyPath());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
  } catch {
    return null;
  }
}

function writeApiKey(key) {
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(key) : Buffer.from(key);
  fs.mkdirSync(path.dirname(apiKeyPath()), { recursive: true });
  fs.writeFileSync(apiKeyPath(), data, { mode: 0o600 });
}

// ---------------------------------------------------------------- state

let settings;
let install;
let tray = null;
let win = null;
let quitting = false;

const state = {
  // unsupported | setup | installing | starting | ready | connected | expired | error
  status: "starting",
  message: "",
  progress: "",
  playing: false,
  track: null,
  context: "",
  volume: null,
  // { ms, at, speed }: playback position `ms` measured at epoch time `at`.
  position: null,
};

function publicState() {
  const meta = install?.meta();
  return {
    ...state,
    settings: { name: settings.name, volume: settings.volume, openAtLogin: getOpenAtLogin() },
    soloist: {
      version: meta?.version ?? null,
      buildDate: meta?.buildDate ?? null,
      daysLeft: install?.daysLeft() ?? null,
    },
    hasApiKey: Boolean(readApiKey()),
    packaged: app.isPackaged,
    platform: process.platform,
    version: app.getVersion(),
  };
}

function update(patch) {
  const wasPlaying = state.playing;
  Object.assign(state, patch);
  win?.webContents.send("state", publicState());
  refreshTray();
  if (wasPlaying && !state.playing && pendingUpdate) applyPendingUpdate();
}

// ---------------------------------------------------------------- logs

const engineLog = [];
function log(line) {
  const apiKey = readApiKey();
  let clean = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (apiKey) clean = clean.split(apiKey).join("[api key]");
  engineLog.push(`${new Date().toISOString()} ${clean}`);
  if (engineLog.length > 500) engineLog.shift();
}

// ---------------------------------------------------------------- engine

const announcer = new Announcer(log);
let engine = null;
let socket = null;
let restartTimer = null;
let restartDelay = 2000;
let signOutOnStart = true; // nobody stays signed in across app launches

function trackFromItem(item) {
  if (!item) return null;
  const d = item.decorations ?? {};
  const covers = d.visual_identity?.cover ?? [];
  const cover =
    covers.find((c) => c.size === "large") ?? covers.find((c) => c.size === "default") ?? covers[0];
  return {
    title: d.identity?.name ?? "Unknown",
    artist: (d.creators ?? []).map((c) => c.entity?.decorations?.identity?.name).filter(Boolean).join(", "),
    album: d.parent?.entity?.decorations?.identity?.name ?? "",
    cover: cover?.url ?? null,
    durationMs: d.playback?.duration_ms ?? 0,
  };
}

function positionFrom(position) {
  if (!position || typeof position.position_ms !== "number") return null;
  return { ms: position.position_ms, at: position.timestamp_ms ?? Date.now(), speed: position.speed ?? 0 };
}

function contextName(context) {
  return context?.decorations?.identity?.name ?? "";
}

function handleSoloistEvent(event) {
  switch (event.type) {
    case "auth_state":
      if (!event.logged_in) {
        update({ status: "ready", playing: false, track: null, context: "", volume: null, position: null });
      } else {
        update({ status: event.is_active ? "connected" : "ready" });
      }
      break;
    case "playback_state":
      update({
        status: event.is_active ? "connected" : "ready",
        playing: event.status === "playing" || event.status === "buffering",
        track: trackFromItem(event.item),
        context: contextName(event.context),
        volume: event.volume ?? state.volume,
        position: positionFrom(event.position),
      });
      rememberVolume(event.volume);
      break;
    case "playback_changed":
      update({ playing: event.status === "playing" || event.status === "buffering" });
      break;
    case "track_changed":
      update({ track: trackFromItem(event.item) });
      break;
    case "position_sync":
      update({ position: positionFrom(event.position) });
      break;
    case "context_changed":
      update({ context: contextName(event.context) });
      break;
    case "volume_changed":
      update({ volume: event.volume });
      rememberVolume(event.volume);
      break;
    case "device_changed":
      update(event.is_active ? { status: "connected" } : { status: "ready", playing: false });
      break;
    case "error":
      log(`soloist api error: ${event.message}`);
      break;
  }
}

function connectSocket(child) {
  const portFile = path.join(install.dataDir, "ws.port");
  const started = Date.now();
  const attempt = () => {
    if (engine !== child) return;
    let port;
    try {
      port = Number(fs.readFileSync(portFile, "utf8").trim());
    } catch {}
    if (!port) {
      if (Date.now() - started < 30000) setTimeout(attempt, 300);
      else log("Soloist's control API never came up");
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    socket = ws;
    ws.addEventListener("message", (message) => {
      try {
        handleSoloistEvent(JSON.parse(String(message.data)));
      } catch {}
    });
    ws.addEventListener("close", () => {
      if (socket === ws) socket = null;
      // Soloist is still running, so the socket just dropped: reconnect.
      if (engine === child) setTimeout(attempt, 1000);
    });
  };
  attempt();
}

function sendSoloist(command, fields = {}) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "command", command, ...fields }));
  }
}

let starting = null;
function startEngine() {
  // Collapse overlapping start requests (resume, settings save, crash restart).
  starting ??= startEngineNow().finally(() => {
    starting = null;
  });
  return starting;
}

async function startEngineNow() {
  clearTimeout(restartTimer);
  if (quitting || engine) return;

  const unsupported = unsupportedReason();
  if (unsupported) return update({ status: "unsupported", message: unsupported });
  const apiKey = readApiKey();
  if (!apiKey || !settings.consented || !install.isInstalled()) return update({ status: "setup" });

  update({ status: "starting", message: "", playing: false, track: null, context: "" });

  if (signOutOnStart) {
    signOutOnStart = false;
    await install.resetSession().catch((error) => log(`session reset failed: ${error.message}`));
  }
  fs.rmSync(path.join(install.dataDir, "ws.port"), { force: true });

  const args = [
    "--device-name", settings.name,
    "--api-key", apiKey,
    "--data-dir", install.dataDir,
    "--cache-dir", install.cacheDir,
    "--cache-size", "512",
    "--initial-volume", String(settings.volume),
    "--ws", "127.0.0.1:0",
    // Verbose output is the only place Soloist reports its Connect port.
    "--verbose",
  ];

  let child;
  try {
    child = spawn(install.exePath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    update({ status: "error", message: `Couldn't start Spotify Soloist: ${error.message}` });
    return;
  }
  engine = child;
  log(`starting soloist ${install.meta()?.version ?? ""}`);

  const onLine = (line) => {
    if (engine !== child) return;
    log(line);
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    const zeroconf = plain.match(/Started ZeroConf service on port (\d+) path (\S+)/);
    if (zeroconf) {
      restartDelay = 2000;
      announcer.start({ name: settings.name, port: Number(zeroconf[1]), path: zeroconf[2] });
      if (state.status === "starting") update({ status: "ready" });
    }
    if (/login failed|make sure api key is valid/i.test(plain)) {
      update({ message: "Spotify rejected the Soloist API key. Check it in Settings." });
    }
  };
  readline.createInterface({ input: child.stdout }).on("line", onLine);
  readline.createInterface({ input: child.stderr }).on("line", onLine);
  connectSocket(child);

  child.on("error", (error) => {
    update({ status: "error", message: `Spotify Soloist failed: ${error.message}` });
  });
  child.on("exit", (code) => {
    log(`soloist exited with code ${code}`);
    if (engine === child) {
      engine = null;
      socket?.close();
      announcer.stop();
    }
    if (quitting || child.intentionalStop) return;
    if (code === 10) {
      // This Soloist build expired. Fetch the current one and carry on.
      update({ status: "expired", message: "This Soloist build expired. Updating…" });
      checkForUpdates({ force: true }).then(() => startEngine());
      return;
    }
    update({ status: "error", message: `Spotify Soloist stopped (code ${code}). Restarting…` });
    restartTimer = setTimeout(startEngine, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
}

function stopEngine() {
  clearTimeout(restartTimer);
  const child = engine;
  engine = null;
  socket?.close();
  socket = null;
  const announced = announcer.stop();
  if (!child) return announced;
  child.intentionalStop = true;
  return Promise.all([
    announced,
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill(); // SIGTERM: Soloist leaves Spotify Connect cleanly
    }),
  ]);
}

async function restartEngine({ signOut = false } = {}) {
  if (quitting) return;
  await stopEngine();
  if (signOut) signOutOnStart = true;
  await startEngine();
}

// Start at the last volume after a restart instead of jumping back to the default.
let volumeSaveTimer = null;
function rememberVolume(percent) {
  if (typeof percent !== "number" || percent === settings.volume) return;
  settings.volume = percent;
  clearTimeout(volumeSaveTimer);
  volumeSaveTimer = setTimeout(saveSettings, 1500);
}

function command(name) {
  switch (name) {
    case "play":
      return sendSoloist("play");
    case "pause":
      return sendSoloist("pause");
    case "next":
      return sendSoloist("skip_next");
    case "prev":
      return sendSoloist("skip_prev");
    case "disconnect":
      // Soloist has no logout command: clear its stored session and restart.
      sendSoloist("pause");
      return restartEngine({ signOut: true });
  }
}

// ---------------------------------------------------------------- updates

let pendingUpdate = false;
let updating = false;

async function applyPendingUpdate() {
  pendingUpdate = false;
  await stopEngine();
  try {
    await install.install((progress) => log(progress));
    log(`updated soloist to ${install.meta()?.version}`);
  } catch (error) {
    log(`update failed: ${error.message}`);
  }
  await startEngine();
}

/** @returns {Promise<string>} a short human-readable result */
async function checkForUpdates({ force = false } = {}) {
  if (updating || !install?.isInstalled()) return "Nothing to update yet.";
  updating = true;
  try {
    const { changed } = await install.remoteChanged();
    const daysLeft = install.daysLeft();
    if (!changed && (daysLeft ?? 1) > 0) return `Up to date (Soloist ${install.meta().version}).`;
    if (force || !state.playing || (daysLeft ?? 0) <= FORCE_UPDATE_DAYS) {
      await applyPendingUpdate();
      return `Updated to Soloist ${install.meta().version}.`;
    }
    pendingUpdate = true; // applied once the current song stops
    return "An update is ready and will install when playback stops.";
  } catch (error) {
    log(`update check failed: ${error.message}`);
    const daysLeft = install.daysLeft();
    if (daysLeft !== null && daysLeft <= WARN_EXPIRY_DAYS) {
      update({
        message: `Couldn't update Spotify Soloist, and this build stops working in ${Math.max(daysLeft, 0)} days.`,
      });
    }
    return `Couldn't check for updates: ${error.message}`;
  } finally {
    updating = false;
    update({});
  }
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
    case "setup":
      return "Needs setup";
    case "installing":
      return state.progress || "Installing Spotify Soloist…";
    case "starting":
      return "Starting…";
    case "ready":
      return `Ready as “${settings.name}”`;
    case "connected":
      if (state.track) return `${state.playing ? "▶" : "❚❚"} ${state.track.title} — ${state.track.artist}`;
      return "Connected";
    case "expired":
      return "Updating Spotify Soloist…";
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
    { type: "separator" },
    {
      label: state.playing ? "Pause" : "Play",
      enabled: connected,
      click: () => command(state.playing ? "pause" : "play"),
    },
    { label: "Next track", enabled: connected, click: () => command("next") },
    { label: "Disconnect listener", enabled: connected, click: () => command("disconnect") },
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

const HEADER_HEIGHT = 52;

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#f6f7f7";
}

function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? "#0b0b0c" : "#ffffff", symbolColor: dark ? "#e5e5e5" : "#262626", height: HEADER_HEIGHT };
}

nativeTheme.on("updated", () => {
  if (!win) return;
  win.setBackgroundColor(windowBackground());
  if (isWin) win.setTitleBarOverlay(titleBarOverlay());
});

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 820,
    minHeight: 580,
    useContentSize: true,
    fullscreenable: false,
    title: "Office Speaker",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    // The app's header doubles as the title bar.
    ...(isMac && { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 19 } }),
    ...(isWin && { titleBarStyle: "hidden", titleBarOverlay: titleBarOverlay() }),
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

function cleanName(value) {
  return String(value ?? "").trim().slice(0, 60);
}

function cleanKey(value) {
  return String(value ?? "").trim();
}

ipcMain.handle("get-state", () => publicState());

ipcMain.handle("command", (_event, name) => {
  if (["play", "pause", "next", "prev", "disconnect"].includes(name)) command(name);
});

ipcMain.handle("seek", (_event, ms) => {
  const position = Math.max(0, Math.round(Number(ms)));
  if (Number.isFinite(position)) sendSoloist("seek", { position_ms: position });
});

ipcMain.handle("set-volume", (_event, percent) => {
  const volume = Math.max(0, Math.min(100, Math.round(Number(percent))));
  if (Number.isFinite(volume)) sendSoloist("set_volume", { volume });
});

ipcMain.handle("setup", async (_event, input) => {
  const name = cleanName(input?.name);
  const apiKey = cleanKey(input?.apiKey);
  if (!input?.consent) return { ok: false, error: "Agree to download Spotify Soloist to continue." };
  if (!apiKey) return { ok: false, error: "Paste your Spotify Soloist API key." };
  if (!name) return { ok: false, error: "Give the speaker a name." };

  writeApiKey(apiKey);
  settings = { ...settings, name, consented: true };
  saveSettings();
  if (!install.isInstalled()) {
    update({ status: "installing", message: "", progress: "Downloading Spotify Soloist…" });
    try {
      await install.install((progress) => update({ progress }));
    } catch (error) {
      update({ status: "setup", progress: "", message: error.message });
      return { ok: false, error: error.message };
    }
  }
  update({ progress: "" });
  await restartEngine({ signOut: true });
  return { ok: true };
});

ipcMain.handle("save-settings", async (_event, next) => {
  const name = cleanName(next?.name);
  if (!name) return { ok: false, error: "Give the speaker a name." };
  const apiKey = cleanKey(next?.apiKey);
  const restart = name !== settings.name || Boolean(apiKey);
  settings = { ...settings, name };
  saveSettings();
  if (apiKey) writeApiKey(apiKey);
  if (typeof next?.openAtLogin === "boolean") setOpenAtLogin(next.openAtLogin);
  if (restart) await restartEngine();
  else update({});
  return { ok: true };
});

ipcMain.handle("check-updates", () => checkForUpdates());

ipcMain.handle("copy-logs", () => {
  clipboard.writeText(engineLog.join("\n"));
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
  install = new SoloistInstall(
    process.env.OFFICE_SPEAKER_SOLOIST_DIR || defaultRoot(app.getPath("userData")),
  );
  const firstRun = settings.firstRun;
  if (firstRun) {
    // A speaker should come back by itself after a reboot.
    setOpenAtLogin(true);
    settings.firstRun = false;
    saveSettings();
  }
  createTray();
  startEngine();

  const launchedHidden =
    process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAsHidden;
  if (firstRun || state.status === "setup" || !launchedHidden) showWindow();

  // Keep Soloist current: each build stops working 90 days after it was built.
  setTimeout(() => checkForUpdates(), 60 * 1000);
  setInterval(() => checkForUpdates(), UPDATE_CHECK_MS);

  // Network sockets and Spotify sessions don't survive sleep well; start fresh.
  powerMonitor.on("resume", () => setTimeout(() => restartEngine(), 3000));
});
