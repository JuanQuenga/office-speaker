// Makes sure phones can find the speaker.
//
// Soloist runs its own mDNS responder, but on some machines it never answers
// on the LAN (spotify/soloist#33). On a Mac it didn't answer at all in testing,
// while its Connect endpoint worked fine. So after Soloist starts we look for
// its announcement, and if it's missing we announce the same endpoint ourselves:
// through the system's Bonjour daemon on macOS, or a JS responder elsewhere.

const { spawn } = require("node:child_process");
const os = require("node:os");
const { Bonjour } = require("bonjour-service");

const SERVICE = "spotify-connect";
const PROBE_MS = 4000;
// A probe from this computer can see Soloist's own announcement over loopback
// even when phones on the LAN can't (spotify/soloist#33), so on the desktop
// platforms we always announce. The probe is only used elsewhere (Linux).
const ALWAYS_ANNOUNCE = process.platform === "darwin" || process.platform === "win32";

function mdnsHost() {
  const name = os.hostname().replace(/\.local\.?$/i, "").replace(/[^a-z0-9-]/gi, "-") || "office-speaker";
  return `${name}.local`;
}

class Announcer {
  constructor(log = () => {}) {
    this.log = log;
    this.child = null;
    this.bonjour = null;
    this.generation = 0;
  }

  /** @param {{ name: string, port: number, path: string }} endpoint */
  async start(endpoint) {
    await this.stop();
    const generation = ++this.generation;

    if (!ALWAYS_ANNOUNCE && (await this.isVisible(endpoint))) {
      this.log(`Soloist's own announcement is visible on port ${endpoint.port}`);
      return;
    }
    if (generation !== this.generation) return; // stopped or restarted meanwhile

    const txt = { CPath: endpoint.path, VERSION: "1.0", Stack: "SP" };
    if (process.platform === "darwin") {
      const args = ["-R", endpoint.name, `_${SERVICE}._tcp`, "local", String(endpoint.port)];
      for (const [key, value] of Object.entries(txt)) args.push(`${key}=${value}`);
      this.child = spawn("dns-sd", args, { stdio: "ignore" });
      this.child.on("error", (error) => this.log(`dns-sd failed: ${error.message}`));
      this.log(`Announcing "${endpoint.name}" through Bonjour on port ${endpoint.port}`);
    } else {
      this.bonjour = new Bonjour({}, (error) => this.log(`mDNS error: ${error?.message ?? error}`));
      this.bonjour.server?.mdns?.on?.("error", (error) => this.log(`mDNS error: ${error.message}`));
      this.bonjour.publish({ name: endpoint.name, type: SERVICE, host: mdnsHost(), port: endpoint.port, txt });
      this.log(`Announcing "${endpoint.name}" on port ${endpoint.port}`);
    }
  }

  /** Looks for a spotify-connect service already advertising this port. */
  isVisible(endpoint) {
    return new Promise((resolve) => {
      let bonjour;
      try {
        bonjour = new Bonjour({}, () => {});
      } catch {
        resolve(false);
        return;
      }
      let found = false;
      const browser = bonjour.find({ type: SERVICE }, (service) => {
        if (service.port === endpoint.port) found = true;
      });
      setTimeout(() => {
        browser.stop();
        bonjour.destroy();
        resolve(found);
      }, PROBE_MS);
    });
  }

  stop() {
    this.generation++;
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    const bonjour = this.bonjour;
    this.bonjour = null;
    if (!bonjour) return Promise.resolve();
    // Send goodbye packets so the speaker disappears from phones promptly.
    return new Promise((resolve) => {
      const timer = setTimeout(done, 1500);
      function done() {
        clearTimeout(timer);
        bonjour.destroy();
        resolve();
      }
      bonjour.unpublishAll(done);
    });
  }
}

module.exports = { Announcer };
