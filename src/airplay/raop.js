// A classic AirPlay (RAOP) audio receiver.
//
// iPhones, iPads and Macs can AirPlay audio to it from any app, including
// Apple Music. It follows the protocol shairport-sync implements for
// "AirPlay 1": RTSP for session control, AES-encrypted ALAC audio over RTP/UDP,
// and DACP for sending play/pause/skip back to the sender.
//
// Events:
//   session  { active: boolean, sender?: string }
//   audio    Int16Array of interleaved stereo PCM at 44.1 kHz
//   flush    the sender paused or seeked; drop anything buffered
//   volume   dB from -30 (quietest) to 0, or -144 for mute
//   metadata { title, artist, album }
//   artwork  data: URL
//   progress { positionMs, durationMs }

"use strict";

const crypto = require("node:crypto");
const dgram = require("node:dgram");
const { EventEmitter } = require("node:events");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const { Bonjour } = require("bonjour-service");

const AIRPORT_KEY = crypto.createPrivateKey(require("./airport-key"));
const { createDecoder, configFromFmtp } = require("./alac");

const SAMPLE_RATE = 44100;
const REORDER_WAIT_MS = 150;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 4 * 1024 * 1024; // artwork is the largest thing senders send
const IDLE_TIMEOUT_MS = 30000; // for connections that never start a session

/** mDNS host name: senders resolve the SRV target over multicast, so it must be .local. */
function mdnsHost() {
  const name = os.hostname().replace(/\.local\.?$/i, "").replace(/[^a-z0-9-]/gi, "-") || "office-speaker";
  return `${name}.local`;
}

class AirPlayReceiver extends EventEmitter {
  /**
   * @param {{ name: string, hardwareId: string, log?: (line: string) => void }} options
   *   hardwareId: 12 hex digits, stable per install; senders treat it as our MAC address.
   */
  constructor({ name, hardwareId, log = () => {} }) {
    super();
    this.name = name;
    this.hardwareId = hardwareId.toUpperCase();
    this.log = log;
    this.server = null;
    this.bonjour = null;
    this.session = null;
    this.port = 0;
    this.sockets = new Set();
  }

  async start() {
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => this.log(`airplay: server error ${error.message}`));
    // 5000 is what AirPort Express used; any port works if it's taken.
    this.port = await listen(this.server, 5000).catch(() => listen(this.server, 0));
    this.bonjour = new Bonjour({}, (error) => this.log(`airplay: mDNS error: ${error?.message ?? error}`));
    this.bonjour.server?.mdns?.on?.("error", (error) => this.log(`airplay: mDNS error: ${error.message}`));
    this.bonjour.publish({
      name: `${this.hardwareId}@${this.name}`,
      type: "raop",
      host: mdnsHost(),
      port: this.port,
      txt: {
        txtvers: "1",
        ch: "2",
        cn: "0,1",
        et: "0,1",
        ek: "1",
        md: "0,1,2",
        sr: String(SAMPLE_RATE),
        ss: "16",
        tp: "UDP",
        vn: "65537",
        vs: "105.1",
        am: "AirPort10,115",
        da: "true",
        sv: "false",
        sf: "0x4",
        pw: "false",
      },
    });
    this.log(`airplay: listening on port ${this.port} as "${this.name}"`);
  }

  async stop() {
    this.endSession("receiver stopped");
    const bonjour = this.bonjour;
    this.bonjour = null;
    if (bonjour) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        bonjour.unpublishAll(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      bonjour.destroy();
    }
    const server = this.server;
    this.server = null;
    // Close every connection, including idle ones, or server.close() never finishes.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  /** Ends the current AirPlay session; the sender falls back to its own speaker. */
  disconnect() {
    this.endSession("disconnected by receiver");
  }

  get active() {
    return Boolean(this.session?.recording);
  }

  // ---------------------------------------------------------------- RTSP

  accept(socket) {
    socket.setNoDelay(true);
    this.sockets.add(socket);
    const connection = { socket, buffer: Buffer.alloc(0), session: null };
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      if (!connection.session) socket.destroy();
    });
    socket.on("data", (chunk) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      let request;
      while ((request = takeRequest(connection))) {
        if (request.invalid) {
          // Malformed or oversized: drop the connection rather than trying to parse on.
          this.log("airplay: dropped a malformed request");
          socket.destroy();
          return;
        }
        try {
          this.handle(connection, request);
        } catch (error) {
          this.log(`airplay: ${request.method} failed: ${error.message}`);
          reply(socket, request, 500);
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (connection.session && this.session === connection.session) this.endSession("sender left");
    });
  }

  handle(connection, request) {
    const { socket } = connection;
    const headers = {};

    if (request.headers["apple-challenge"]) {
      headers["Apple-Response"] = this.challengeResponse(socket, request.headers["apple-challenge"]);
    }

    switch (request.method) {
      case "OPTIONS":
        headers.Public =
          "ANNOUNCE, SETUP, RECORD, PAUSE, FLUSH, TEARDOWN, OPTIONS, GET_PARAMETER, SET_PARAMETER";
        return reply(socket, request, 200, headers);

      case "ANNOUNCE": {
        const sdp = parseSdp(request.body.toString("utf8"));
        if (!/AppleLossless/i.test(sdp.rtpmap ?? "")) {
          this.log(`airplay: unsupported audio format ${sdp.rtpmap}`);
          return reply(socket, request, 415, headers);
        }
        // A new sender takes over, like picking a speaker in Spotify.
        // The same connection re-announcing keeps its socket; anyone else takes over.
        if (this.session) {
          this.endSession(this.session === connection.session ? "sender restarted" : "another sender took over", {
            keepSocket: this.session === connection.session,
          });
        }
        const key = crypto.privateDecrypt(
          { key: AIRPORT_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
          fromBase64(sdp.rsaaeskey),
        );
        connection.session = this.session = new Session({
          receiver: this,
          socket,
          key,
          iv: fromBase64(sdp.aesiv),
          config: configFromFmtp(sdp.fmtp),
          dacpId: request.headers["dacp-id"],
          activeRemote: request.headers["active-remote"],
          userAgent: request.headers["user-agent"] ?? "",
        });
        return reply(socket, request, 200, headers);
      }

      case "SETUP": {
        const session = connection.session;
        if (!session) return reply(socket, request, 451, headers);
        const transport = request.headers.transport ?? "";
        const controlPort = Number(transport.match(/control_port=(\d+)/)?.[1] ?? 0);
        const timingPort = Number(transport.match(/timing_port=(\d+)/)?.[1] ?? 0);
        session.dacpId ??= request.headers["dacp-id"];
        session.activeRemote ??= request.headers["active-remote"];
        session
          .openSockets(controlPort, timingPort)
          .then((ports) => {
            headers.Transport =
              `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;` +
              `control_port=${ports.control};timing_port=${ports.timing};server_port=${ports.audio}`;
            headers.Session = "1";
            headers["Audio-Jack-Status"] = "connected; type=analog";
            reply(socket, request, 200, headers);
          })
          .catch((error) => {
            this.log(`airplay: SETUP failed: ${error.message}`);
            reply(socket, request, 500, headers);
          });
        return;
      }

      case "RECORD": {
        const session = connection.session;
        if (!session) return reply(socket, request, 451, headers);
        if (!session.recording) {
          session.recording = true;
          this.emit("session", { active: true, sender: session.senderName() });
        }
        headers["Audio-Latency"] = "11025";
        return reply(socket, request, 200, headers);
      }

      case "FLUSH":
      case "PAUSE":
        connection.session?.flush();
        this.emit("flush");
        return reply(socket, request, 200, headers);

      case "SET_PARAMETER":
        this.setParameter(request, connection.session);
        return reply(socket, request, 200, headers);

      case "GET_PARAMETER": {
        const body = request.body.toString("utf8").includes("volume")
          ? `volume: ${(connection.session?.volumeDb ?? -15).toFixed(6)}\r\n`
          : "";
        headers["Content-Type"] = "text/parameters";
        return reply(socket, request, 200, headers, body);
      }

      case "TEARDOWN":
        headers.Connection = "close";
        reply(socket, request, 200, headers);
        if (connection.session && this.session === connection.session) this.endSession("sender stopped");
        connection.session = null;
        return;

      case "POST":
        // AirPlay 2 / FairPlay endpoints we don't offer.
        return reply(socket, request, 200, headers);

      default:
        return reply(socket, request, 501, headers);
    }
  }

  /** Signs the sender's challenge with the AirPort key to prove we're a real receiver. */
  challengeResponse(socket, challengeB64) {
    const challenge = fromBase64(challengeB64).subarray(0, 16);
    let address = socket.localAddress ?? "";
    if (address.startsWith("::ffff:")) address = address.slice(7);
    const ip = net.isIPv4(address)
      ? Buffer.from(address.split(".").map(Number))
      : ipv6Bytes(address);
    const mac = Buffer.from(this.hardwareId, "hex");
    let message = Buffer.concat([challenge, ip, mac]);
    if (message.length < 32) message = Buffer.concat([message, Buffer.alloc(32 - message.length)]);
    const signature = crypto.privateEncrypt(
      { key: AIRPORT_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      message,
    );
    return signature.toString("base64").replace(/=+$/, "");
  }

  setParameter(request, session) {
    const type = (request.headers["content-type"] ?? "").toLowerCase();
    if (type.startsWith("text/parameters")) {
      const text = request.body.toString("utf8");
      const volume = text.match(/volume:\s*(-?[\d.]+)/);
      if (volume) {
        const db = Number(volume[1]);
        if (session) session.volumeDb = db;
        this.emit("volume", db);
      }
      const progress = text.match(/progress:\s*(\d+)\/(\d+)\/(\d+)/);
      if (progress) {
        const [start, current, end] = progress.slice(1).map(Number);
        this.emit("progress", {
          positionMs: (((current - start) >>> 0) / SAMPLE_RATE) * 1000,
          durationMs: (((end - start) >>> 0) / SAMPLE_RATE) * 1000,
        });
      }
    } else if (type.startsWith("application/x-dmap-tagged")) {
      const tags = parseDmap(request.body);
      this.emit("metadata", { title: tags.minm ?? "", artist: tags.asar ?? "", album: tags.asal ?? "" });
    } else if (type.startsWith("image/")) {
      if (request.body.length > 0) {
        this.emit("artwork", `data:${type.split(";")[0]};base64,${request.body.toString("base64")}`);
      } else {
        this.emit("artwork", null);
      }
    }
  }

  endSession(reason, { keepSocket = false } = {}) {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.log(`airplay: session ended (${reason})`);
    session.close({ keepSocket });
    if (session.recording) this.emit("session", { active: false });
  }

  // ---------------------------------------------------------------- DACP

  /** Sends a remote-control command to the phone that's playing (play/pause/skip/volume). */
  async remote(command) {
    const session = this.session;
    if (!session?.dacpId || !session.activeRemote) return false;
    const endpoint = await this.findDacp(session.dacpId);
    if (!endpoint) return false;
    return new Promise((resolve) => {
      const request = http.get(
        {
          host: endpoint.host,
          port: endpoint.port,
          path: `/ctrl-int/1/${command}`,
          headers: { "Active-Remote": session.activeRemote },
          timeout: 3000,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        },
      );
      request.on("error", () => resolve(false));
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
    });
  }

  findDacp(dacpId) {
    const session = this.session;
    if (session?.dacpEndpoint) return Promise.resolve(session.dacpEndpoint);
    return new Promise((resolve) => {
      const bonjour = this.bonjour ?? new Bonjour({}, () => {});
      const browser = bonjour.find({ type: "dacp" }, (service) => {
        if (service.name !== `iTunes_Ctrl_${dacpId}`) return;
        const host = service.addresses?.find((a) => net.isIPv4(a)) ?? service.referer?.address;
        if (!host) return;
        finish({ host, port: service.port });
      });
      const timer = setTimeout(() => finish(null), 3000);
      function finish(endpoint) {
        clearTimeout(timer);
        browser.stop();
        if (endpoint && session) session.dacpEndpoint = endpoint;
        resolve(endpoint);
      }
    });
  }
}

// ---------------------------------------------------------------- session

class Session {
  constructor({ receiver, socket, key, iv, config, dacpId, activeRemote, userAgent }) {
    this.receiver = receiver;
    this.socket = socket;
    this.key = key;
    this.iv = iv;
    this.decoder = createDecoder(config);
    this.dacpId = dacpId;
    this.activeRemote = activeRemote;
    this.userAgent = userAgent;
    this.volumeDb = -15;
    this.recording = false;
    this.sockets = [];
    this.remote = { host: socket.remoteAddress, controlPort: 0 };
    // Reordering: packets by sequence number, released in order.
    this.pending = new Map();
    this.nextSeq = null;
    this.waitingSince = 0;
    this.resendSeq = 0;
    this.timer = setInterval(() => this.release(true), 50);
  }

  senderName() {
    const agent = this.userAgent;
    if (/iPhone/i.test(agent)) return "iPhone";
    if (/iPad/i.test(agent)) return "iPad";
    if (/Mac/i.test(agent)) return "Mac";
    return "";
  }

  async openSockets(controlPort, timingPort) {
    const family = net.isIPv6(this.remote.host) && !this.remote.host.startsWith("::ffff:") ? "udp6" : "udp4";
    const bind = async (onMessage) => {
      const udp = dgram.createSocket(family);
      udp.on("message", onMessage);
      udp.on("error", () => {});
      await new Promise((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(0, () => resolve());
      });
      this.sockets.push(udp);
      return udp;
    };
    this.remote.controlPort = controlPort;
    this.remote.timingPort = timingPort;
    const audio = await bind((packet) => this.onAudio(packet));
    this.control = await bind((packet) => this.onControl(packet));
    const timing = await bind((packet, rinfo) => this.onTiming(timing, packet, rinfo));
    return { audio: audio.address().port, control: this.control.address().port, timing: timing.address().port };
  }

  onAudio(packet) {
    if (packet.length < 12) return;
    const type = packet[1] & 0x7f;
    if (type !== 0x60) return;
    this.accept(packet.readUInt16BE(2), packet.subarray(12));
  }

  onControl(packet) {
    if (packet.length < 4) return;
    const type = packet[1] & 0x7f;
    // 0x56: a retransmitted audio packet, wrapped in a 4-byte header.
    if (type === 0x56 && packet.length >= 16) {
      const inner = packet.subarray(4);
      this.accept(inner.readUInt16BE(2), inner.subarray(12));
    }
    // 0x54 sync packets carry timing for multi-room sync, which we don't do.
  }

  onTiming(udp, packet, rinfo) {
    // Answer NTP-style timing requests (0x52) so senders that ask are happy.
    if (packet.length < 32 || (packet[1] & 0x7f) !== 0x52) return;
    const reply = Buffer.alloc(32);
    reply[0] = 0x80;
    reply[1] = 0xd3;
    reply.writeUInt16BE(7, 2);
    packet.copy(reply, 8, 24, 32); // origin = their transmit time
    const now = ntpNow();
    now.copy(reply, 16);
    now.copy(reply, 24);
    udp.send(reply, rinfo.port, rinfo.address);
  }

  accept(seq, payload) {
    if (!this.recording) return;
    if (this.nextSeq === null) this.nextSeq = seq;
    // Ignore packets that are already behind playback.
    if (seqBefore(seq, this.nextSeq)) return;
    if (!this.pending.has(seq)) this.pending.set(seq, payload);
    this.release(false);
  }

  release(fromTimer) {
    if (this.nextSeq === null) return;
    while (this.pending.has(this.nextSeq)) {
      this.play(this.pending.get(this.nextSeq));
      this.pending.delete(this.nextSeq);
      this.nextSeq = (this.nextSeq + 1) & 0xffff;
      this.waitingSince = 0;
    }
    if (this.pending.size === 0) return;
    // A gap: ask the sender to resend once, then give up after a short wait.
    const now = Date.now();
    if (!this.waitingSince) {
      this.waitingSince = now;
      this.requestResend(this.nextSeq, this.missingCount());
    } else if (fromTimer && now - this.waitingSince > REORDER_WAIT_MS) {
      // Still missing: skip past the whole gap rather than waiting packet by packet.
      this.nextSeq = (this.nextSeq + this.missingCount()) & 0xffff;
      this.waitingSince = 0;
      this.release(false);
    }
  }

  missingCount() {
    let count = 0;
    let seq = this.nextSeq;
    while (!this.pending.has(seq) && count < 64) {
      count++;
      seq = (seq + 1) & 0xffff;
    }
    return count;
  }

  requestResend(seq, count) {
    if (!this.control || !this.remote.controlPort) return;
    const request = Buffer.alloc(8);
    request[0] = 0x80;
    request[1] = 0xd5;
    request.writeUInt16BE((this.resendSeq = (this.resendSeq + 1) & 0xffff), 2);
    request.writeUInt16BE(seq, 4);
    request.writeUInt16BE(count, 6);
    this.control.send(request, this.remote.controlPort, this.remote.host.replace(/^::ffff:/, ""));
  }

  play(payload) {
    let pcm;
    try {
      pcm = this.decoder.decode(this.decrypt(payload));
    } catch (error) {
      this.receiver.log(`airplay: dropped a bad packet (${error.message})`);
      return;
    }
    if (this.decoder.config.numChannels === 1) pcm = monoToStereo(pcm);
    this.receiver.emit("audio", pcm);
  }

  decrypt(payload) {
    // AES-128-CBC over whole 16-byte blocks; any tail is sent in the clear.
    const length = payload.length & ~0xf;
    const decipher = crypto.createDecipheriv("aes-128-cbc", this.key, this.iv);
    decipher.setAutoPadding(false);
    const head = decipher.update(payload.subarray(0, length));
    decipher.final();
    return Buffer.concat([head, payload.subarray(length)]);
  }

  flush() {
    this.pending.clear();
    this.nextSeq = null;
    this.waitingSince = 0;
  }

  close({ keepSocket = false } = {}) {
    clearInterval(this.timer);
    for (const udp of this.sockets) {
      try {
        udp.close();
      } catch {}
    }
    this.sockets = [];
    if (!keepSocket) this.socket.destroy();
  }
}

// ---------------------------------------------------------------- helpers

function listen(server, port) {
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
    server.listen(port);
  });
}

/** Pulls one complete RTSP request off the connection buffer, if there is one. */
function takeRequest(connection) {
  const end = connection.buffer.indexOf("\r\n\r\n");
  if (end < 0) return connection.buffer.length > MAX_HEADER_BYTES ? { invalid: true } : null;
  if (end > MAX_HEADER_BYTES) return { invalid: true };
  const head = connection.buffer.subarray(0, end).toString("utf8").split("\r\n");
  const [method, path] = head[0].split(" ");
  const headers = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const lengthHeader = headers["content-length"] ?? "0";
  if (!/^\d{1,9}$/.test(lengthHeader)) return { invalid: true };
  const length = Number(lengthHeader);
  if (length > MAX_BODY_BYTES) return { invalid: true };
  if (connection.buffer.length < end + 4 + length) return null;
  const body = connection.buffer.subarray(end + 4, end + 4 + length);
  connection.buffer = connection.buffer.subarray(end + 4 + length);
  return { method, path, headers, body: Buffer.from(body) };
}

const STATUS = {
  200: "OK",
  415: "Unsupported Media Type",
  451: "Parameter Not Understood",
  500: "Internal Server Error",
  501: "Not Implemented",
};

function reply(socket, request, status, headers = {}, body = "") {
  if (socket.destroyed) return;
  const payload = Buffer.from(body);
  const lines = [`RTSP/1.0 ${status} ${STATUS[status] ?? "OK"}`, `CSeq: ${request.headers.cseq ?? 0}`, "Server: AirTunes/105.1"];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  if (payload.length) lines.push(`Content-Length: ${payload.length}`);
  socket.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), payload]));
}

function parseSdp(text) {
  const sdp = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^a=([\w-]+):(.*)$/);
    if (match) sdp[match[1]] = match[2].trim();
  }
  return sdp;
}

function fromBase64(value = "") {
  // Senders often omit base64 padding.
  const clean = value.trim();
  return Buffer.from(clean + "===".slice((clean.length + 3) % 4), "base64");
}

function ipv6Bytes(address) {
  const bytes = Buffer.alloc(16);
  const [head, tail = ""] = address.split("%")[0].split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  groups.forEach((group, i) => bytes.writeUInt16BE(parseInt(group || "0", 16), i * 2));
  return bytes;
}

/** Reads the DMAP fields we show (title, artist, album) from SET_PARAMETER metadata. */
function parseDmap(buffer) {
  const out = {};
  const walk = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      const tag = buffer.toString("latin1", offset, offset + 4);
      const length = buffer.readUInt32BE(offset + 4);
      const valueStart = offset + 8;
      const valueEnd = Math.min(valueStart + length, end);
      if (tag === "mlit") walk(valueStart, valueEnd);
      else if (tag === "minm" || tag === "asar" || tag === "asal") {
        out[tag] = buffer.toString("utf8", valueStart, valueEnd);
      }
      offset = valueEnd;
    }
  };
  walk(0, buffer.length);
  return out;
}

function seqBefore(a, b) {
  return ((a - b) & 0xffff) > 0x8000;
}

function monoToStereo(mono) {
  const stereo = new Int16Array(mono.length * 2);
  for (let i = 0; i < mono.length; i++) stereo[i * 2] = stereo[i * 2 + 1] = mono[i];
  return stereo;
}

function ntpNow() {
  const ms = Date.now() + 2208988800000; // NTP epoch is 1900
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(ms / 1000) >>> 0, 0);
  buffer.writeUInt32BE(Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0, 4);
  return buffer;
}

module.exports = { AirPlayReceiver, parseDmap };
