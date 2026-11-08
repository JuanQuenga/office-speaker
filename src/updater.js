// Keeps Office Speaker itself up to date from GitHub Releases.
//
// Windows: electron-updater downloads new versions in the background. Installing
// needs an admin prompt (it's a per-machine install), so it waits for someone to
// click "Restart to update" rather than popping up on an unattended speaker.
//
// macOS: auto-update requires a signed app and these builds aren't signed, so the
// app only checks for a newer release and links to it.

"use strict";

const { app, shell } = require("electron");

const REPO = "JuanQuenga/office-speaker";
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function isNewer(candidate, current) {
  const parse = (version) => version.replace(/^v/, "").split(/[.-]/).map((part) => Number(part) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

class AppUpdater {
  constructor({ log = () => {}, onChange = () => {}, netFetch }) {
    this.log = log;
    this.onChange = onChange;
    this.netFetch = netFetch;
    this.status = "idle"; // idle | checking | downloading | ready | available | current | error
    this.version = null;
    this.percent = 0;
    this.error = "";
    this.autoUpdater = null;
    this.supported = app.isPackaged && (process.platform === "win32" || process.platform === "darwin");
    if (this.supported && process.platform === "win32") this.setUpAutoUpdater();
  }

  setUpAutoUpdater() {
    const { autoUpdater } = require("electron-updater");
    this.autoUpdater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false; // would surprise someone with an admin prompt on shutdown
    autoUpdater.logger = {
      info: (message) => this.log(`updater: ${message}`),
      warn: (message) => this.log(`updater: ${message}`),
      error: (message) => this.log(`updater: ${message}`),
      debug: () => {},
    };
    // Test hook, limited to this computer: lets CI exercise a real update end to end.
    const feed = process.env.OFFICE_SPEAKER_UPDATE_URL;
    if (feed?.startsWith("http://127.0.0.1:")) autoUpdater.setFeedURL({ provider: "generic", url: feed });

    autoUpdater.on("checking-for-update", () => this.set({ status: "checking", error: "" }));
    autoUpdater.on("update-available", (info) => this.set({ status: "downloading", version: info.version, percent: 0 }));
    autoUpdater.on("update-not-available", () => this.set({ status: "current" }));
    autoUpdater.on("download-progress", (progress) => this.set({ percent: Math.round(progress.percent) }));
    autoUpdater.on("update-downloaded", (info) => this.set({ status: "ready", version: info.version, percent: 100 }));
    autoUpdater.on("error", (error) => {
      this.log(`updater: ${error?.message ?? error}`);
      this.set({ status: "error", error: "Couldn't check for updates." });
    });
  }

  set(patch) {
    Object.assign(this, patch);
    this.onChange();
  }

  state() {
    return {
      supported: this.supported,
      status: this.status,
      version: this.version,
      percent: this.percent,
      error: this.error,
      // Windows installs in place; macOS builds aren't signed, so people download them.
      canInstall: Boolean(this.autoUpdater),
    };
  }

  start() {
    if (!this.supported) return;
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  async check() {
    if (!this.supported || this.status === "downloading" || this.status === "ready") return;
    if (this.autoUpdater) {
      // Errors arrive through the "error" event as well.
      await this.autoUpdater.checkForUpdates().catch(() => {});
      return;
    }
    this.set({ status: "checking", error: "" });
    try {
      const response = await this.netFetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `OfficeSpeaker/${app.getVersion()}` },
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const { tag_name: tag } = await response.json();
      if (tag && isNewer(tag, app.getVersion())) this.set({ status: "available", version: tag.replace(/^v/, "") });
      else this.set({ status: "current" });
    } catch (error) {
      this.log(`updater: ${error.message}`);
      this.set({ status: "error", error: "Couldn't check for updates." });
    }
  }

  /** Windows: restart into the downloaded update. macOS: open the download page. */
  install() {
    if (this.autoUpdater && this.status === "ready") {
      this.log(`updater: installing ${this.version}`);
      this.autoUpdater.quitAndInstall(true, true); // silent, then reopen the app
    } else if (!this.autoUpdater && this.status === "available") {
      shell.openExternal(RELEASES_URL);
    }
  }
}

module.exports = { AppUpdater, isNewer };
