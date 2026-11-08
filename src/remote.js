// A small web server on the office network:
//  - "/" is a phone page anyone on the Wi-Fi can open (via the QR code in the
//    app) to see what's playing and pick a radio station.
//  - "/radio/stream" relays the current station to this computer's audio
//    player. Only this computer can use it.

"use strict";

const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const PREFERRED_PORT = 7979;
const PAGE = path.join(__dirname, "remote", "index.html");

class RemoteServer {
  /**
   * @param {{
   *   state: () => object,
   *   search: (query: { q?: string, tag?: string }) => Promise<object[]>,
   *   play: (stationId: string) => Promise<{ ok: boolean, error?: string }>,
   *   stop: () => void,
   *   stream: (res: http.ServerResponse) => void,
   *   log?: (line: string) => void,
   * }} handlers
   */
  constructor(handlers, { lan = true } = {}) {
    this.handlers = handlers;
    // When the phone page is off, only this computer can connect (for the radio relay).
    this.host = lan ? undefined : "127.0.0.1";
    this.lan = lan;
    this.log = handlers.log ?? (() => {});
    this.server = null;
    this.port = 0;
  }

  async start() {
    const server = http.createServer((req, res) => {
      this.route(req, res).catch((error) => {
        this.log(`remote: ${req.method} ${req.url} failed: ${error.message}`);
        if (!res.headersSent) json(res, 500, { error: "Something went wrong" });
      });
    });
    this.server = server;
    this.port = await listen(server, PREFERRED_PORT, this.host).catch(() => listen(server, 0, this.host));
    this.address = this.lan ? ((await routedAddress()) ?? lanAddress()) : null;
    this.log(`remote: phone page at ${this.url()}`);
  }

  stop() {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  /** Loopback URL for this computer's own audio player. */
  localUrl(pathname) {
    return `http://127.0.0.1:${this.port}${pathname}`;
  }

  /** The address coworkers open on their phones. */
  url() {
    if (!this.lan) return null;
    const ip = this.address;
    return ip && this.port ? `http://${ip}:${this.port}/` : null;
  }

  async route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const local = isLoopback(req.socket.remoteAddress);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; connect-src 'self'",
      });
      fs.createReadStream(PAGE).pipe(res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, this.handlers.state());
    }

    if (req.method === "GET" && url.pathname === "/api/radio") {
      const q = url.searchParams.get("q")?.slice(0, 80) || undefined;
      const tag = url.searchParams.get("tag")?.slice(0, 40) || undefined;
      return json(res, 200, { stations: await this.handlers.search({ q, tag }) });
    }

    if (req.method === "POST" && url.pathname === "/api/radio/play") {
      const body = await readJson(req);
      const result = await this.handlers.play(String(body?.id ?? ""));
      return json(res, result.ok ? 200 : 400, result);
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      this.handlers.stop();
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/radio/stream") {
      if (!local) return json(res, 403, { error: "Forbidden" });
      return this.handlers.stream(res);
    }

    json(res, 404, { error: "Not found" });
  }
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) req.destroy();
      else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server.address().port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function isLoopback(address = "") {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * The address the OS would use to reach the internet: the real network adapter,
 * not a Hyper-V, WSL, VPN or Docker one. No packet is sent; UDP connect only routes.
 */
function routedAddress() {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const done = (address) => {
      try {
        socket.close();
      } catch {}
      resolve(address);
    };
    socket.on("error", () => done(null));
    try {
      socket.connect(53, "1.1.1.1", () => {
        const { address } = socket.address();
        done(address && address !== "0.0.0.0" && !address.startsWith("127.") ? address : null);
      });
    } catch {
      done(null);
    }
  });
}

/** Fallback when there's no route: pick the likeliest office-network address. */
function lanAddress() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr|vmnet|vbox|utun|tailscale|tun|tap|zt|wg|awdl|llw|bridge)|vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback/i.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const ip = address.address;
      const privateRange =
        /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      candidates.push({ ip, score: privateRange ? 2 : /^169\.254\./.test(ip) ? 0 : 1 });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.ip ?? null;
}

module.exports = { RemoteServer, lanAddress };
