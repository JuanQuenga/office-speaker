// Installs, verifies and updates Spotify Soloist, Spotify's official headless
// Spotify Connect player. Soloist may not be redistributed, so it's never
// bundled: the user's own computer downloads it from Spotify's CDN after the
// user agrees, and it's refreshed before each build's 90-day expiry.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const CDN = "https://soloist-builds.spotifycdn.com";
const BUILD_LIFETIME_DAYS = 90;
// Spotify AB's Apple Developer ID team.
const SPOTIFY_APPLE_TEAM = "2FNC3A47ZF";

const PLATFORMS = {
  "darwin-arm64": { file: "soloist_release_osx_arm64.tar.gz", exe: "soloist" },
  "win32-x64": { file: "soloist_release_windows_x86_64.zip", exe: "soloist.exe" },
  "linux-x64": { file: "soloist_release_x86_64.tar.gz", exe: "soloist" },
  "linux-arm64": { file: "soloist_release_arm64.tar.gz", exe: "soloist" },
};

function platform() {
  return PLATFORMS[`${process.platform}-${process.arch}`] ?? null;
}

function unsupportedReason() {
  if (platform()) return null;
  if (process.platform === "darwin") return "Spotify Soloist only runs on Apple Silicon Macs.";
  if (process.platform === "win32") return "Spotify Soloist only runs on 64-bit Intel/AMD Windows PCs.";
  return "Spotify Soloist isn't available for this computer.";
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 60000, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

class SoloistInstall {
  /** @param {string} root directory that holds bin/, data/, cache/ and install.json */
  constructor(root) {
    this.root = root;
    this.binDir = path.join(root, "bin");
    this.dataDir = path.join(root, "data");
    this.cacheDir = path.join(root, "cache");
    this.metaPath = path.join(root, "install.json");
  }

  get exePath() {
    return path.join(this.binDir, platform().exe);
  }

  meta() {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath, "utf8"));
    } catch {
      return null;
    }
  }

  isInstalled() {
    return Boolean(platform()) && fs.existsSync(this.exePath) && Boolean(this.meta());
  }

  /** Days until the installed build stops working (negative once expired). */
  daysLeft() {
    const meta = this.meta();
    if (!meta?.buildDate) return null;
    const expires = Date.parse(meta.buildDate) + BUILD_LIFETIME_DAYS * 86400000;
    return Math.floor((expires - Date.now()) / 86400000);
  }

  url() {
    return `${CDN}/${platform().file}`;
  }

  /** Is there a build on the CDN that differs from the installed one? */
  async remoteChanged() {
    const response = await fetch(this.url(), { method: "HEAD" });
    if (!response.ok) throw new Error(`Spotify's download server answered ${response.status}`);
    const tag = response.headers.get("etag") || response.headers.get("last-modified");
    const meta = this.meta();
    return { changed: !meta || !tag || tag !== meta.tag, tag };
  }

  /**
   * Downloads, extracts and verifies the current build into a staging folder,
   * then swaps it in. Call only while Soloist is stopped (or for a first install).
   */
  async install(onProgress = () => {}) {
    const spec = platform();
    if (!spec) throw new Error(unsupportedReason());
    await fsp.mkdir(this.root, { recursive: true });
    const staging = await fsp.mkdtemp(path.join(this.root, "staging-"));
    try {
      onProgress("Downloading Spotify Soloist…");
      const response = await fetch(this.url());
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const archive = path.join(staging, spec.file);
      await fsp.writeFile(archive, Buffer.from(await response.arrayBuffer()));
      const tag = response.headers.get("etag") || response.headers.get("last-modified");

      onProgress("Unpacking…");
      const extracted = path.join(staging, "out");
      await fsp.mkdir(extracted);
      // bsdtar ships with macOS and Windows 10+, and reads both .tar.gz and .zip.
      await run(process.platform === "win32" ? "tar.exe" : "tar", ["-xf", archive, "-C", extracted]);
      const exe = path.join(extracted, spec.exe);
      if (!fs.existsSync(exe)) throw new Error("The download didn't contain the Soloist program.");
      if (process.platform !== "win32") await fsp.chmod(exe, 0o755);

      onProgress("Checking Spotify's signature…");
      await verifySignature(exe);
      const version = await readVersion(exe);

      onProgress("Installing…");
      const oldBin = `${this.binDir}.old`;
      await fsp.rm(oldBin, { recursive: true, force: true });
      if (fs.existsSync(this.binDir)) await fsp.rename(this.binDir, oldBin);
      await fsp.rename(extracted, this.binDir);
      await fsp.rm(oldBin, { recursive: true, force: true });
      const meta = { ...version, tag, installedAt: new Date().toISOString() };
      await fsp.writeFile(this.metaPath, JSON.stringify(meta, null, 2));
      return meta;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Signs out whoever is connected: clears Soloist's stored session and caches
   * but keeps .device_id, so phones still see the same speaker.
   */
  async resetSession() {
    const idFile = path.join(this.dataDir, ".device_id");
    const deviceId = fs.existsSync(idFile) ? await fsp.readFile(idFile) : null;
    await fsp.rm(this.dataDir, { recursive: true, force: true });
    await fsp.mkdir(this.dataDir, { recursive: true });
    if (deviceId) await fsp.writeFile(idFile, deviceId);
  }
}

async function verifySignature(exe) {
  if (process.platform === "darwin") {
    await run("codesign", ["--verify", "--strict", exe]).catch(() => {
      throw new Error("The downloaded Soloist isn't validly signed.");
    });
    const { stderr } = await run("codesign", ["-dv", "--verbose=2", exe]);
    if (!stderr.includes(`TeamIdentifier=${SPOTIFY_APPLE_TEAM}`)) {
      throw new Error("The downloaded Soloist isn't signed by Spotify.");
    }
  } else if (process.platform === "win32") {
    const script =
      "$s = Get-AuthenticodeSignature -LiteralPath $env:SOLOIST_EXE; " +
      "Write-Output $s.Status; Write-Output $s.SignerCertificate.Subject";
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, SOLOIST_EXE: exe } },
    );
    const [status, subject = ""] = stdout.trim().split(/\r?\n/);
    if (status !== "Valid" || !/Spotify/i.test(subject)) {
      throw new Error("The downloaded Soloist isn't signed by Spotify.");
    }
  }
  // Linux builds aren't signed; they come straight from Spotify's CDN over HTTPS.
}

async function readVersion(exe) {
  const { stdout } = await run(exe, ["--version"]);
  // "soloist 1.3.10.51 build 1793988108 (20261106) (g19412df6ea) (macos/aarch64)"
  const match = stdout.match(/soloist\s+(\S+)\s+build\s+\S+\s+\((\d{4})(\d{2})(\d{2})\)/);
  if (!match) throw new Error(`Couldn't read the Soloist version: ${stdout.trim()}`);
  return { version: match[1], buildDate: `${match[2]}-${match[3]}-${match[4]}` };
}

/** Where Soloist lives. Windows uses ProgramData so the firewall rule's path is fixed. */
function defaultRoot(userData) {
  if (process.platform === "win32") {
    return path.join(process.env.ProgramData || "C:\\ProgramData", "Office Speaker", "soloist");
  }
  return path.join(userData, "soloist");
}

module.exports = { SoloistInstall, defaultRoot, platform, unsupportedReason, BUILD_LIFETIME_DAYS };
