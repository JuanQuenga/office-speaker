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

const crypto = require("node:crypto");

const { AudioOutput, dbFromPercent, gainFromDb, percentFromDb } = require("./airplay/output");
const { AirPlayReceiver } = require("./airplay/raop");
const QRCode = require("qrcode");

const { Announcer } = require("./announce");
const { RadioDirectory, cleanStation, relayStream } = require("./radio");
const { RemoteServer } = require("./remote");
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
let apiKeyCache; // undefined: not read yet
function readApiKey() {
  if (apiKeyCache !== undefined) return apiKeyCache;
  try {
    const raw = fs.readFileSync(apiKeyPath());
    apiKeyCache = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8");
  } catch {
    apiKeyCache = null;
  }
  return apiKeyCache;
}

function writeApiKey(key) {
  apiKeyCache = key;
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

/** What the window and tray show: an active AirPlay session takes over the player. */
function view() {
  if (airplayState.active) {
    return {
      ...state,
      status: "connected",
      source: "airplay",
      playing: airplayState.playing,
      track: airplayState.track,
      context: "",
      volume: airplayState.volume,
      position: airplayState.position,
    };
  }
  if (radioState.active) {
    const station = radioState.station;
    const details = [station.country, station.tags.slice(0, 2).join(", ")].filter(Boolean).join(" · ");
    return {
      ...state,
      status: "connected",
      source: "radio",
      playing: radioState.status === "playing",
      track: {
        title: radioState.title || station.name,
        artist: radioState.title ? station.name : details,
        album: "",
        cover: station.favicon,
        durationMs: 0,
      },
      context: "",
      volume: settings.radioVolume ?? 70,
      position: null,
      message: radioState.error || state.message,
    };
  }
  return { ...state, source: state.status === "connected" ? "spotify" : null };
}

function publicState() {
  const meta = install?.meta();
  return {
    ...view(),
    airplay: { supported: airplaySupported(), enabled: airplayEnabled(), running: Boolean(airplay) },
    radio: {
      station: radioState.active ? radioState.station : null,
      status: radioState.active ? radioState.status : "idle",
      favorites: settings.radioFavorites ?? [],
      recent: settings.radioRecent ?? [],
    },
    remote: { enabled: remoteEnabled(), url: remote?.url() ?? null, qr: remoteQr.url === remote?.url() ? remoteQr.data : null },
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
  if (wasPlaying && !state.playing && pendingUpdate && !updatePromise) applyPendingUpdate();
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

function handleSoloistEvent(event, { snapshot = false } = {}) {
  // Someone started Spotify while AirPlay or radio was playing: Spotify wins.
  // The snapshot Soloist sends when the control socket (re)connects describes
  // existing state, not a new choice, so it doesn't count as a takeover.
  const spotifyPlaying =
    (event.type === "playback_changed" && event.status === "playing") ||
    (!snapshot && event.type === "playback_state" && event.status === "playing" && event.is_active);
  if (spotifyPlaying) spotifyPausePending = false;
  if (spotifyPlaying && airplayState.active) airplay?.disconnect();
  if (spotifyPlaying && radioState.active) stopRadio();

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
    let first = true;
    ws.addEventListener("open", () => {
      // A takeover (radio/AirPlay) may have happened while the socket was down.
      if (spotifyPausePending) {
        spotifyPausePending = false;
        sendSoloist("pause");
      }
    });
    ws.addEventListener("message", (message) => {
      let event;
      try {
        event = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const snapshot = first && (event.type === "playback_state" || event.type === "auth_state");
      if (event.type === "playback_state") first = false;
      handleSoloistEvent(event, { snapshot });
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
    return true;
  }
  return false;
}

// Pausing Spotify when another source takes over must not get lost if the
// control socket happens to be reconnecting.
let spotifyPausePending = false;
function pauseSpotify() {
  if (!sendSoloist("pause") && engine) spotifyPausePending = true;
}

let starting = null;
let engineEpoch = 0; // bumped by stopEngine so an unfinished start gives up
let expiredRestarts = 0;
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
  const epoch = engineEpoch;

  const unsupported = unsupportedReason();
  if (unsupported) return update({ status: "unsupported", message: unsupported });
  const apiKey = readApiKey();
  if (!apiKey || !settings.consented || !install.isInstalled()) return update({ status: "setup" });

  update({ status: "starting", message: "", playing: false, track: null, context: "" });

  // A Soloist left over from a killed/crashed run (or an upgrade) would keep
  // playing on its own and lock its files.
  await install.killStale().catch((error) => log(`couldn't stop an old Soloist: ${error.message}`));
  if (signOutOnStart) {
    signOutOnStart = false;
    await install.resetSession().catch((error) => log(`session reset failed: ${error.message}`));
  }
  // Stopped, quitting, or updating while we waited: don't start after all.
  if (quitting || engine || epoch !== engineEpoch || updatePromise) return;
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
      expiredRestarts = 0;
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
    // e.g. blocked by AppLocker/antivirus: 'exit' may never follow.
    log(`soloist failed to run: ${error.message}`);
    if (engine === child) {
      engine = null;
      socket?.close();
      announcer.stop();
    }
    update({ status: "error", message: `Spotify Soloist couldn't run: ${error.message}` });
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
      // This Soloist build expired. Fetch the current one and carry on, but
      // don't spin if the update can't be had (offline, CDN unchanged).
      if (++expiredRestarts > 3) {
        update({
          status: "error",
          message: "Spotify Soloist expired and couldn't be updated. Check the internet connection, then use Check for updates.",
        });
        return;
      }
      update({ status: "expired", message: "This Soloist build expired. Updating…" });
      checkForUpdates({ force: true }).then(() => {
        restartTimer = setTimeout(startEngine, 5000 * expiredRestarts);
      });
      return;
    }
    update({ status: "error", message: `Spotify Soloist stopped (code ${code}). Restarting…` });
    restartTimer = setTimeout(startEngine, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
}

function stopEngine() {
  clearTimeout(restartTimer);
  engineEpoch++;
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
  if (updatePromise) await updatePromise; // the update restarts it anyway
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
  if (airplayState.active) return airplayCommand(name);
  if (radioState.active) return radioCommand(name);
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

// ---------------------------------------------------------------- radio

const directory = new RadioDirectory({ userAgent: `OfficeSpeaker/${app.getVersion()}`, log });
const stationCache = new Map(); // id -> station, for stations picked from the phone page
const browseCache = new Map(); // query -> { at, stations }

const radioState = {
  active: false,
  station: null,
  title: "", // song title from the stream, when the station sends one
  status: "idle", // buffering | playing | paused | error
  error: "",
  generation: 0,
};

async function browseRadio({ q, tag }) {
  const key = q ? `q:${q.toLowerCase()}` : tag ? `t:${tag.toLowerCase()}` : "popular";
  const cached = browseCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.stations;
  const stations = q ? await directory.search(q) : tag ? await directory.byTag(tag) : await directory.popular();
  if (stationCache.size > 3000) stationCache.clear(); // favorites/recents are looked up separately
  for (const station of stations) stationCache.set(station.id, station);
  if (browseCache.size > 100) browseCache.delete(browseCache.keys().next().value);
  browseCache.set(key, { at: Date.now(), stations });
  return stations;
}

function knownStation(id) {
  return (
    stationCache.get(id) ??
    (settings.radioFavorites ?? []).find((s) => s.id === id) ??
    (settings.radioRecent ?? []).find((s) => s.id === id) ??
    null
  );
}

async function playRadio(input) {
  const station = cleanStation(input);
  if (!station) return { ok: false, error: "That station can't be played." };
  if (!remote?.port) return { ok: false, error: "Radio isn't ready yet." };
  // Radio takes over from Spotify and AirPlay.
  pauseSpotify();
  if (airplayState.active) airplay?.disconnect();

  radioState.generation++;
  Object.assign(radioState, { active: true, station, title: "", status: "buffering", error: "" });
  settings.radioRecent = [station, ...(settings.radioRecent ?? []).filter((s) => s.id !== station.id)].slice(0, 8);
  saveSettings();
  directory.reportClick(station.id);
  log(`radio: playing ${station.name}`);
  update({});
  await output.playRadio(
    remote.localUrl(`/radio/stream?g=${radioState.generation}`),
    (settings.radioVolume ?? 70) / 100,
  );
  return { ok: true };
}

function pauseRadio() {
  if (!radioState.active) return;
  output.stopRadio(); // live radio can't pause; stop and reconnect on play
  radioState.generation++;
  Object.assign(radioState, { status: "paused", title: "" });
  update({});
}

function stopRadio() {
  if (!radioState.active) return;
  output.stopRadio();
  radioState.generation++;
  Object.assign(radioState, { active: false, station: null, title: "", status: "idle", error: "" });
  update({});
}

function radioCommand(name) {
  if (name === "play" && radioState.station) return playRadio(radioState.station);
  if (name === "pause") return pauseRadio();
  if (name === "disconnect") return stopRadio();
}

function handleRadioEvent(event) {
  if (!radioState.active || radioState.status === "paused") return;
  if (event.state === "playing") Object.assign(radioState, { status: "playing", error: "" });
  else if (event.state === "buffering") radioState.status = "buffering";
  else if (event.state === "error" || event.state === "ended") {
    log(`radio: ${event.message ?? event.state}`);
    Object.assign(radioState, { status: "error", error: "This station stopped playing. Try another one." });
  }
  update({});
}

/** Relays the current station to the audio window, reading song titles on the way. */
function streamRadio(res) {
  if (!radioState.active || radioState.status === "paused") {
    res.writeHead(404).end();
    return;
  }
  const generation = radioState.generation;
  relayStream(radioState.station.url, res, {
    userAgent: `OfficeSpeaker/${app.getVersion()}`,
    onTitle: (title) => {
      if (generation !== radioState.generation || title === radioState.title) return;
      radioState.title = title;
      update({});
    },
    onError: (message) => {
      if (generation !== radioState.generation) return;
      log(`radio: ${message}`);
      Object.assign(radioState, { status: "error", error: "Couldn't reach this station. Try another one." });
      update({});
    },
  });
}

// ---------------------------------------------------------------- phone page

let remote = null;
const remoteQr = { url: null, data: null };

function remoteEnabled() {
  return settings?.remote !== false;
}

/** What the phone page shows. */
function remoteState() {
  const current = view();
  const playing = current.status === "connected";
  return {
    name: settings.name,
    source: playing ? current.source : null,
    playing: playing && current.playing,
    title: playing ? current.track?.title ?? "" : "",
    subtitle: playing ? [current.track?.artist, current.track?.album].filter(Boolean).join(" — ") : "",
    cover: playing ? current.track?.cover ?? null : null,
    isArtwork: current.source !== "radio",
    stationId: radioState.active ? radioState.station.id : null,
    airplay: Boolean(airplay),
  };
}

async function startRemote() {
  if (remote || quitting) return;
  const server = new RemoteServer(
    {
      state: remoteState,
      search: browseRadio,
      play: async (id) => {
        const station = knownStation(id);
        return station ? playRadio(station) : { ok: false, error: "Pick a station from the list." };
      },
      stop: stopRadio,
      stream: streamRadio,
      log,
    },
    { lan: remoteEnabled() },
  );
  remote = server;
  try {
    await server.start();
    const url = server.url();
    if (url && remoteQr.url !== url) {
      remoteQr.url = url;
      remoteQr.data = await QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: "#111312", light: "#ffffff" } });
    }
  } catch (error) {
    log(`remote: couldn't start: ${error.message}`);
    if (remote === server) remote = null;
  }
  update({});
}

async function restartRemote() {
  const server = remote;
  remote = null;
  await server?.stop(); // this also cuts the radio relay
  await startRemote();
  // Reconnect the radio to the new server.
  if (radioState.active && radioState.status !== "paused") playRadio(radioState.station);
}

// ---------------------------------------------------------------- AirPlay

// macOS has its own AirPlay Receiver (System Settings > General > AirDrop &
// Handoff), so the built-in receiver only runs elsewhere, mainly Windows.
function airplaySupported() {
  return !isMac;
}

function airplayEnabled() {
  return airplaySupported() && settings?.airplay !== false;
}

let airplay = null;
const airplayState = {
  active: false,
  playing: false,
  track: null,
  volume: null,
  position: null,
};

const output = new AudioOutput({
  log,
  onRadio: (event) => handleRadioEvent(event),
  onStats: (stats) => {
    if (!airplayState.active || stats.playing === airplayState.playing) return;
    airplayState.playing = stats.playing;
    // Freeze or resume the progress bar along with the audio.
    if (airplayState.position) {
      const p = airplayState.position;
      const ms = p.speed ? p.ms + (Date.now() - p.at) : p.ms;
      airplayState.position = { ms, at: Date.now(), speed: stats.playing ? 1 : 0 };
    }
    update({});
  },
});

function hardwareId() {
  // Senders treat this as the receiver's MAC address; keep it stable.
  if (!/^[0-9a-f]{12}$/i.test(settings.airplayId ?? "")) {
    settings.airplayId = crypto.randomBytes(6).toString("hex");
    saveSettings();
  }
  return settings.airplayId;
}

async function startAirPlay() {
  if (airplay || !airplayEnabled() || quitting) return;
  const receiver = new AirPlayReceiver({ name: settings.name, hardwareId: hardwareId(), log });
  airplay = receiver;

  receiver.on("session", ({ active }) => {
    if (active) {
      pauseSpotify(); // AirPlay takes over from Spotify and radio
      stopRadio();
      Object.assign(airplayState, {
        active: true,
        playing: false,
        track: { title: "AirPlay", artist: "", album: "", cover: null, durationMs: 0 },
        position: null,
      });
      output.open();
      log("airplay: session started");
    } else {
      output.flush();
      Object.assign(airplayState, { active: false, playing: false, track: null, position: null });
      // Bring back whatever Spotify was showing.
      sendSoloist("get_auth_state");
      sendSoloist("get_state");
    }
    update({});
  });
  receiver.on("audio", (pcm) => output.write(pcm));
  receiver.on("flush", () => output.flush());
  receiver.on("volume", (db) => {
    output.setGain(gainFromDb(db));
    airplayState.volume = percentFromDb(db);
    update({});
  });
  receiver.on("metadata", ({ title, artist, album }) => {
    airplayState.track = { ...(airplayState.track ?? {}), title: title || "AirPlay", artist, album };
    update({});
  });
  receiver.on("artwork", (cover) => {
    airplayState.track = { ...(airplayState.track ?? { title: "AirPlay", artist: "", album: "" }), cover };
    update({});
  });
  receiver.on("progress", ({ positionMs, durationMs }) => {
    airplayState.track = { ...(airplayState.track ?? { title: "AirPlay", artist: "", album: "" }), durationMs };
    airplayState.position = { ms: positionMs, at: Date.now(), speed: airplayState.playing ? 1 : 0 };
    update({});
  });

  try {
    await receiver.start();
  } catch (error) {
    log(`airplay: couldn't start: ${error.message}`);
    if (airplay === receiver) airplay = null;
  }
  update({});
}

async function stopAirPlay() {
  const receiver = airplay;
  airplay = null;
  if (receiver) await receiver.stop().catch(() => {});
  output.flush(); // the audio window stays up for radio
  if (airplayState.active) {
    Object.assign(airplayState, { active: false, playing: false, track: null, position: null });
    update({});
  }
}

async function restartAirPlay() {
  await stopAirPlay();
  await startAirPlay();
}

function airplayCommand(name) {
  switch (name) {
    case "play":
      return airplay?.remote("play");
    case "pause":
      return airplay?.remote("pause");
    case "next":
      return airplay?.remote("nextitem");
    case "prev":
      return airplay?.remote("previtem");
    case "disconnect":
      return airplay?.disconnect();
  }
}

// ---------------------------------------------------------------- updates

let pendingUpdate = false;
let updating = false;
let updatePromise = null; // the one install in progress; everything else waits for it

function applyPendingUpdate() {
  updatePromise ??= (async () => {
    pendingUpdate = false;
    await stopEngine();
    try {
      await install.install((progress) => log(progress));
      log(`updated soloist to ${install.meta()?.version}`);
    } catch (error) {
      log(`update failed: ${error.message}`);
    }
  })().finally(() => {
    updatePromise = null;
    startEngine();
  });
  return updatePromise;
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

// On Windows the login item is matched by its arguments, so read it with the
// same args it's registered with, or it always reads as off.
const LOGIN_ARGS = ["--hidden"];

function getOpenAtLogin() {
  if (!app.isPackaged) return false;
  return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
}

function setOpenAtLogin(enabled) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: LOGIN_ARGS });
}

// ---------------------------------------------------------------- UI

function statusLine() {
  const state = view();
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
      if (state.track) {
        const by = state.track.artist ? ` — ${state.track.artist}` : "";
        return `${state.playing ? "▶" : "❚❚"} ${state.track.title}${by}`;
      }
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
  const state = view();
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
  if (isMac) return "#00000000"; // let the sidebar's vibrancy show through
  return nativeTheme.shouldUseDarkColors ? "#0b0b0c" : "#ffffff";
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
    width: 980,
    height: 660,
    minWidth: 820,
    minHeight: 560,
    useContentSize: true,
    fullscreenable: false,
    title: "Office Speaker",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    // The app draws its own title bar: traffic lights sit in the sidebar on
    // macOS (with the native translucent sidebar material), and Windows keeps
    // its caption buttons as an overlay on the top right.
    ...(isMac && {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 19 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
    }),
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
  if (!Number.isFinite(position)) return;
  if (airplayState.active) airplay?.remote(`setproperty?dacp.playingtime=${position}`);
  else if (!radioState.active) sendSoloist("seek", { position_ms: position });
});

ipcMain.handle("set-volume", (_event, percent) => {
  const volume = Math.max(0, Math.min(100, Math.round(Number(percent))));
  if (!Number.isFinite(volume)) return;
  if (airplayState.active) {
    // Adjust locally right away, and tell the phone so its slider follows.
    const db = dbFromPercent(volume);
    output.setGain(gainFromDb(db));
    airplayState.volume = volume;
    airplay?.remote(`setproperty?dmcp.device-volume=${db.toFixed(6)}`);
    update({});
  } else if (radioState.active) {
    settings.radioVolume = volume;
    output.setRadioVolume(volume / 100);
    clearTimeout(volumeSaveTimer);
    volumeSaveTimer = setTimeout(saveSettings, 1500);
    update({});
  } else sendSoloist("set_volume", { volume });
});

ipcMain.handle("radio-browse", async (_event, query) => {
  try {
    return { ok: true, stations: await browseRadio(query ?? {}) };
  } catch (error) {
    return { ok: false, error: `Couldn't load stations (${error.message})`, stations: [] };
  }
});

ipcMain.handle("radio-play", (_event, station) => playRadio(station));
ipcMain.handle("radio-stop", () => stopRadio());

ipcMain.handle("radio-favorite", (_event, input, on) => {
  const station = cleanStation(input);
  if (!station) return;
  const rest = (settings.radioFavorites ?? []).filter((s) => s.id !== station.id);
  settings.radioFavorites = on ? [station, ...rest].slice(0, 50) : rest;
  saveSettings();
  update({});
});

ipcMain.handle("open-airplay-settings", () => {
  // macOS's own AirPlay Receiver lives under General > AirDrop & Handoff.
  if (isMac) shell.openExternal("x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension");
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
  startAirPlay();
  return { ok: true };
});

ipcMain.handle("save-settings", async (_event, next) => {
  const name = cleanName(next?.name);
  if (!name) return { ok: false, error: "Give the speaker a name." };
  const apiKey = cleanKey(next?.apiKey);
  const renamed = name !== settings.name;
  const restart = renamed || Boolean(apiKey);
  const airplayChanged = typeof next?.airplay === "boolean" && next.airplay !== airplayEnabled();
  settings = { ...settings, name };
  if (typeof next?.airplay === "boolean") settings.airplay = next.airplay;
  const remoteChanged = typeof next?.remote === "boolean" && next.remote !== remoteEnabled();
  if (typeof next?.remote === "boolean") settings.remote = next.remote;
  saveSettings();
  if (apiKey) writeApiKey(apiKey);
  if (typeof next?.openAtLogin === "boolean") setOpenAtLogin(next.openAtLogin);
  if (renamed || airplayChanged) await restartAirPlay();
  if (remoteChanged) await restartRemote();
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
  stopRadio();
  const deadline = new Promise((resolve) => setTimeout(resolve, 6000));
  Promise.race([Promise.allSettled([stopEngine(), stopAirPlay(), remote?.stop()]), deadline]).finally(() =>
    app.exit(0),
  );
});

// A network hiccup in a library shouldn't pop a "JavaScript error" dialog on the speaker.
process.on("uncaughtException", (error) => log(`uncaught: ${error?.stack ?? error}`));
process.on("unhandledRejection", (error) => log(`unhandled: ${error?.stack ?? error}`));

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
  if (settings.consented) startAirPlay();
  startRemote();

  const launchedHidden =
    process.argv.includes("--hidden") || app.getLoginItemSettings({ args: LOGIN_ARGS }).wasOpenedAsHidden;
  if (firstRun || state.status === "setup" || !launchedHidden) showWindow();

  // Keep Soloist current: each build stops working 90 days after it was built.
  setTimeout(() => checkForUpdates(), 60 * 1000);
  setInterval(() => checkForUpdates(), UPDATE_CHECK_MS);

  // Network sockets and Spotify sessions don't survive sleep well; start fresh.
  powerMonitor.on("resume", () =>
    setTimeout(() => {
      restartEngine();
      restartAirPlay();
      restartRemote().then(() => {
        if (radioState.active && radioState.status !== "paused") playRadio(radioState.station);
      });
    }, 3000),
  );
});
