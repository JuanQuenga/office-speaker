// End-to-end test of the real Windows installer on a real Windows machine.
// usage: node test/windows-smoke.mjs <installer.exe> <update feed dir> <next version> <results dir>
//
// Soloist accepts a dummy API key until someone logs in, so everything except an
// actual Spotify login can be exercised without secrets.
//
// Hard checks fail the run. Soft checks depend on things CI machines may lack
// (an audio device, multicast, internet radio stations) and only warn.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Bonjour } from "bonjour-service";
import { sendAirPlay } from "./airplay-sender.mjs";

const [installer, feedDir, nextVersion, resultsDir] = process.argv.slice(2);
fs.mkdirSync(resultsDir, { recursive: true });

const INSTALL_DIR = "C:\\Program Files\\Office Speaker";
const APP_EXE = path.join(INSTALL_DIR, "Office Speaker.exe");
const UNINSTALLER = path.join(INSTALL_DIR, "Uninstall Office Speaker.exe");
const DATA_ROOT = path.join(process.env.ProgramData, "Office Speaker");
const SOLOIST_DIR = path.join(DATA_ROOT, "soloist");
const USER_DATA = path.join(process.env.APPDATA, "Office Speaker");
const LOG_FILE = path.join(USER_DATA, "logs", "office-speaker.log");
const DEBUG_PORT = 9333;
const NAME = "CI Speaker";

const results = [];
function check(name, ok, detail = "", { soft = false } = {}) {
  const status = ok ? "PASS" : soft ? "WARN" : "FAIL";
  results.push({ status, name, detail });
  console.log(`[${status}] ${name}${detail ? ` -- ${detail}` : ""}`);
  return ok;
}
function note(name, detail) {
  results.push({ status: "INFO", name, detail });
  console.log(`[INFO] ${name} -- ${detail}`);
}
async function section(title, run) {
  console.log(`\n=== ${title}`);
  try {
    await run();
  } catch (error) {
    check(`${title}: finished without errors`, false, error?.stack ?? String(error));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch {}
    await sleep(everyMs);
  }
  return last ?? null;
}
const run = (file, args = []) => spawnSync(file, args, { encoding: "utf8", windowsHide: true });
const powershell = (command) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]).stdout?.trim() ?? "";

function soloistProcesses() {
  const json = powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='soloist.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  );
  if (!json) return [];
  return [JSON.parse(json)].flat().filter((p) => !/--type=crashpad/.test(p.CommandLine ?? ""));
}
const appRunning = () => /Office Speaker/.test(run("tasklist.exe", ["/FI", "IMAGENAME eq Office Speaker.exe", "/NH"]).stdout ?? "");
const killApp = () => run("taskkill.exe", ["/F", "/IM", "Office Speaker.exe"]);
const logText = () => {
  try {
    return fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return "";
  }
};
const firewallRule = (name) => run("netsh.exe", ["advfirewall", "firewall", "show", "rule", `name=${name}`, "verbose"]).stdout ?? "";

// ---------------------------------------------------------------- the running app

let cdp = null;

function launch(env = {}) {
  const child = spawn(APP_EXE, [`--remote-debugging-port=${DEBUG_PORT}`], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...env },
  });
  child.unref();
}

async function connect() {
  cdp?.ws.close();
  cdp = null;
  const target = await waitFor(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
    return targets.find((t) => t.type === "page" && t.url.includes("dist-renderer"));
  }, 45000);
  if (!target) throw new Error("the app's window never appeared");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  cdp = { ws, send };
}

async function evaluate(expression) {
  const { result } = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "page error");
  return result?.result?.value;
}
const getState = () => evaluate("window.speaker.getState()");

async function screenshot(name) {
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 980, height: 660, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(resultsDir, `${name}.png`), Buffer.from(shot.result.data, "base64"));
  } catch (error) {
    note(`screenshot ${name}`, error.message);
  }
}

const logPort = (pattern) => Number([...logText().matchAll(pattern)].at(-1)?.[1] ?? 0);
const airplayPort = () => logPort(/airplay: listening on port (\d+)/g);
const connectPort = () => logPort(/Started ZeroConf service on port (\d+)/g);

function hardwareId() {
  return JSON.parse(fs.readFileSync(path.join(USER_DATA, "settings.json"), "utf8")).airplayId;
}

// ---------------------------------------------------------------- the test

await section("Install", async () => {
  const install = run(installer, ["/S"]);
  check("installer exits cleanly", install.status === 0, `exit ${install.status}`);
  check("app is installed", await waitFor(() => fs.existsSync(APP_EXE), 60000), APP_EXE);
  check("uninstaller is installed", fs.existsSync(UNINSTALLER));
  check("Soloist folder is created", fs.existsSync(SOLOIST_DIR), SOLOIST_DIR);

  const acl = run("icacls.exe", [DATA_ROOT]).stdout ?? "";
  check("regular users can write to the Soloist folder", /BUILTIN\\Users:.*\(M\)/.test(acl) || /Users:.*\(M\)/.test(acl), acl.split("\n").find((l) => /Users/.test(l))?.trim() ?? acl);

  const appRule = firewallRule("Office Speaker");
  check("firewall rule for the app", appRule.includes(APP_EXE) && /Allow/i.test(appRule));
  const soloistRule = firewallRule("Office Speaker (Soloist)");
  check("firewall rule for Soloist", soloistRule.includes(path.join(SOLOIST_DIR, "bin", "soloist.exe")) && /Allow/i.test(soloistRule));
});

await section("First launch and setup", async () => {
  killApp();
  await sleep(1000);
  launch();
  await connect();
  const first = await waitFor(async () => {
    const state = await getState();
    return state?.status === "setup" ? state : null;
  }, 20000);
  check("opens on the setup screen", Boolean(first), first?.status);
  await screenshot("1-setup");

  const started = Date.now();
  const result = await evaluate(
    `window.speaker.setup({ name: ${JSON.stringify(NAME)}, apiKey: "ci-dummy-key", consent: true })`,
  );
  check("setup downloads, verifies and installs Soloist", result?.ok === true, result?.ok ? `${Date.now() - started} ms` : result?.error);
  check("soloist.exe is in place", fs.existsSync(path.join(SOLOIST_DIR, "bin", "soloist.exe")));

  const ready = await waitFor(async () => {
    const state = await getState();
    return state?.status === "ready" ? state : null;
  }, 30000);
  const state = ready ?? (await getState());
  check("reaches Ready", Boolean(ready), `status=${state?.status} message=${state?.message}`);
  check("reports the Soloist version and days left", Boolean(state?.soloist?.version) && state?.soloist?.daysLeft > 0, JSON.stringify(state?.soloist));
  check("one Soloist is running", soloistProcesses().length === 1, `${soloistProcesses().length} running`);
  check("Soloist writes the pid file cleanup relies on", fs.existsSync(path.join(SOLOIST_DIR, "data", "soloist.pid")));
  check("the API key is stored encrypted", !fs.readFileSync(path.join(USER_DATA, "soloist-api-key")).includes("ci-dummy-key"));
  check("the log file doesn't contain the API key", !logText().includes("ci-dummy-key"));
  await screenshot("2-ready");
});

await section("Spotify Connect endpoint", async () => {
  const port = connectPort();
  check("the app found Soloist's Connect port", port > 0, `port ${port}`);
  const info = await (await fetch(`http://127.0.0.1:${port}/zc?action=getInfo`)).json();
  check("Soloist answers Spotify's handshake with our name", info.remoteName === NAME, `remoteName=${info.remoteName} status=${info.status}`);
});

await section("Start at login", async () => {
  const state = await getState();
  check("the app reports start at login on", state.settings.openAtLogin === true);
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const read = () => run("reg.exe", ["query", key]).stdout ?? "";
  check("it's in the registry with --hidden", /Office Speaker\.exe/.test(read()) && /--hidden/.test(read()), read().split("\n").find((l) => /Office Speaker/.test(l))?.trim());

  // The bug both reviewers found: saving any setting used to turn this off.
  await evaluate(`window.speaker.saveSettings({ name: ${JSON.stringify(NAME)}, airplay: true })`);
  check("saving other settings leaves it on", /Office Speaker\.exe/.test(read()) && (await getState()).settings.openAtLogin === true);
});

await section("Network announcements", async () => {
  const seen = await new Promise((resolve) => {
    const found = {};
    const bonjour = new Bonjour({}, () => {});
    bonjour.find({ type: "raop" }, (service) => {
      if (service.name.endsWith(`@${NAME}`)) found.airplay = true;
    });
    bonjour.find({ type: "spotify-connect" }, (service) => {
      if (service.name === NAME || service.port === connectPort()) found.spotify = true;
    });
    setTimeout(() => {
      bonjour.destroy();
      resolve(found);
    }, 8000);
  });
  check("AirPlay announcement is visible on this machine", Boolean(seen.airplay), "", { soft: true });
  check("Spotify announcement is visible on this machine", Boolean(seen.spotify), "", { soft: true });
});

await section("AirPlay", async () => {
  const port = airplayPort();
  check("the AirPlay receiver is listening", port > 0, `port ${port}`);
  const result = await sendAirPlay({
    host: "127.0.0.1",
    port,
    hardwareId: hardwareId(),
    seconds: 7,
    during: async () => {
      const state = await getState();
      await screenshot("3-airplay");
      return state;
    },
  });
  const during = result.during;
  check("Apple-Challenge signature is valid", result.challengeValid === true);
  check("session setup succeeds", result.announce === 200 && result.setup === 200 && result.record === 200);
  check("the player switches to AirPlay", during?.source === "airplay", `source=${during?.source}`);
  check("song info comes through", during?.track?.title === "Test Tone" && during?.track?.artist === "AirPlay Sender", during?.track?.title);
  check("a dropped packet is requested again", result.resent >= 1, `resent ${result.resent}`);
  check("audio reaches the output engine", during?.playing === true, "needs an audio device", { soft: true });
  const after = await waitFor(async () => {
    const state = await getState();
    return state.source !== "airplay" ? state : null;
  }, 10000);
  check("hanging up ends the session", Boolean(after), `source=${after?.source}`);
});

await section("Malformed network input", async () => {
  const port = airplayPort();
  const closed = await new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write("OPTIONS * RTSP/1.0\r\nCSeq: 1\r\nContent-Length: nope\r\n\r\n"));
    socket.on("close", () => resolve(true));
    socket.on("error", () => {});
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 3000);
  });
  check("a malformed AirPlay request is dropped", closed);
  check("the app stays responsive afterwards", Boolean(await getState()));
});

let lanUrl = null;
await section("Phone page", async () => {
  const state = await getState();
  lanUrl = state.remote.url;
  check("a phone address and QR code are available", Boolean(lanUrl) && Boolean(state.remote.qr), lanUrl);
  const local = "http://127.0.0.1:7979";
  const page = await fetch(`${local}/`);
  check("the page loads", page.status === 200 && (await page.text()).includes("Office Speaker"));
  const api = await (await fetch(`${local}/api/state`)).json();
  check("the API reports the speaker name", api.name === NAME, api.name);
  if (lanUrl) {
    const relay = await fetch(new URL("/radio/stream", lanUrl));
    check("the radio relay refuses other devices", relay.status === 403, `status ${relay.status}`);
  }
});

await section("Radio and source takeover", async () => {
  const local = "http://127.0.0.1:7979";
  const { stations } = await (await fetch(`${local}/api/radio?tag=jazz`)).json();
  check("station search works", stations?.length > 0, `${stations?.length ?? 0} stations`, { soft: true });
  if (!stations?.length) return;

  let playing = null;
  for (const station of stations.filter((s) => s.codec === "MP3").slice(0, 5)) {
    await fetch(`${local}/api/radio/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: station.id }),
    });
    playing = await waitFor(async () => {
      const state = await getState();
      return state.radio.status === "playing" ? state : null;
    }, 15000);
    if (playing) break;
  }
  const state = playing ?? (await getState());
  check("the player switches to radio", state.source === "radio", `source=${state.source} status=${state.radio.status}`);
  check("a station plays through the proxy-aware relay", Boolean(playing), state.radio.station?.name ?? "", { soft: true });
  await screenshot("4-radio");

  if (state.source === "radio") {
    const result = await sendAirPlay({ host: "127.0.0.1", port: airplayPort(), hardwareId: hardwareId(), seconds: 5, during: getState });
    check("AirPlay takes over from radio", result.during?.source === "airplay" && result.during?.radio?.station === null, `source=${result.during?.source}`);
  }
});

await section("Force-killing the app", async () => {
  const before = soloistProcesses().map((p) => p.ProcessId);
  killApp();
  await sleep(2000);
  const orphans = soloistProcesses().map((p) => p.ProcessId);
  note("Soloist after a force-kill", `${orphans.length} still running (Windows doesn't stop children)`);
  launch();
  await connect();
  const ready = await waitFor(async () => {
    const state = await getState();
    return state?.status === "ready" ? state : null;
  }, 30000);
  check("the app comes back Ready with its key and settings", Boolean(ready), ready?.status);
  const after = soloistProcesses().map((p) => p.ProcessId);
  check("exactly one Soloist is running", after.length === 1, `before=${before} orphans=${orphans} after=${after}`);
  check("the leftover Soloist was replaced", !after.some((pid) => orphans.includes(pid)));
});

await section("Installing over a running copy", async () => {
  check("the app is running first", appRunning());
  const install = run(installer, ["/S"]);
  check("installer exits cleanly", install.status === 0, `exit ${install.status}`);
  await sleep(3000);
  check("the installer stopped Soloist", soloistProcesses().length === 0, `${soloistProcesses().length} running`);
  killApp();
  await sleep(1000);
  launch();
  await connect();
  const ready = await waitFor(async () => {
    const state = await getState();
    return state?.status === "ready" ? state : null;
  }, 30000);
  check("settings survive the upgrade", Boolean(ready) && ready.settings.name === NAME, ready?.settings?.name);
  check("exactly one Soloist is running", soloistProcesses().length === 1);
});

await section("Auto-update", async () => {
  // Serve the next version's installer and latest.yml from this machine.
  const server = http.createServer((req, res) => {
    const file = path.join(feedDir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Length": fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const feed = `http://127.0.0.1:${server.address().port}/`;

  killApp();
  await sleep(1500);
  launch({ OFFICE_SPEAKER_UPDATE_URL: feed });
  await connect();
  await evaluate("window.speaker.appUpdateCheck()");
  const ready = await waitFor(async () => {
    const state = await getState();
    return state?.update?.status === "ready" || state?.update?.status === "error" ? state : null;
  }, 120000, 1000);
  check("finds and downloads the new version", ready?.update?.status === "ready", JSON.stringify(ready?.update));
  await screenshot("5-update-ready");

  if (ready?.update?.status === "ready") {
    const versionOf = () => powershell(`(Get-Item '${APP_EXE}').VersionInfo.ProductVersion`);
    evaluate("window.speaker.appUpdateInstall()").catch(() => {});
    const updated = await waitFor(() => versionOf().startsWith(nextVersion), 180000, 2000);
    check("the update installs", Boolean(updated), `installed ${versionOf()}, expected ${nextVersion}`);
    const relaunched = await waitFor(async () => {
      const api = await (await fetch("http://127.0.0.1:7979/api/state")).json();
      return api?.name === NAME ? api : null;
    }, 60000, 2000);
    check("the app reopens by itself with its settings", Boolean(relaunched), relaunched?.name);
    check("exactly one Soloist is running after the update", (await waitFor(() => soloistProcesses().length === 1, 30000)) === true, `${soloistProcesses().length} running`);
  }
  server.close();
});

await section("Uninstall", async () => {
  cdp?.ws.close();
  cdp = null;
  check("the uninstaller is there", fs.existsSync(UNINSTALLER));
  killApp();
  run(UNINSTALLER, ["/S"]);
  const gone = await waitFor(() => !fs.existsSync(APP_EXE), 60000, 1000);
  check("the app is removed", Boolean(gone));
  check("firewall rules are removed", !firewallRule("Office Speaker").includes(APP_EXE) && !firewallRule("Office Speaker (Soloist)").includes("soloist.exe"));
  check("Soloist is stopped", soloistProcesses().length === 0);
});

// ---------------------------------------------------------------- report

if (fs.existsSync(LOG_FILE)) fs.copyFileSync(LOG_FILE, path.join(resultsDir, "office-speaker.log"));
const lines = results.map((r) => `${r.status}  ${r.name}${r.detail ? ` -- ${r.detail}` : ""}`);
const uncaught = logText().split("\n").filter((line) => /uncaught:|unhandled:/.test(line));
if (uncaught.length) lines.push(`WARN  uncaught errors in the app log: ${uncaught.length}`);
fs.writeFileSync(path.join(resultsDir, "results.txt"), `${lines.join("\n")}\n`);

const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
const passed = results.filter((r) => r.status === "PASS");
const summary = `Windows smoke test: ${passed.length} passed, ${warned.length} warnings, ${failed.length} failed`;
console.log(`\n${summary}`);
for (const line of uncaught.slice(0, 20)) console.log(line);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ${summary}\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`);
}
process.exit(failed.length ? 1 : 0);
