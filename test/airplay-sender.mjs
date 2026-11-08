// A scripted AirPlay (RAOP) sender that follows the same steps as an iPhone:
// OPTIONS with an Apple-Challenge, ANNOUNCE with an RSA-wrapped AES key, SETUP,
// RECORD, then AES-encrypted ALAC over RTP with one packet dropped on purpose.

import crypto from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";
import { createRequire } from "node:module";
import { createAlacEncoder } from "@audio/encode-alac/core";

const require = createRequire(import.meta.url);
const PUBLIC_KEY = crypto.createPublicKey(crypto.createPrivateKey(require("../src/airplay/airport-key.js")));

const unpadded = (buffer) => buffer.toString("base64").replace(/=+$/, "");

/**
 * Opens a session and streams `seconds` of a muted tone. `during` runs while audio flows.
 * @returns {Promise<object>} what the receiver did, for the caller to check
 */
export async function sendAirPlay({ host, port, hardwareId, seconds = 6, during = async () => {} }) {
  const result = {};
  const socket = net.connect(port, host);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.on("error", () => {});

  let cseq = 0;
  let pending = null;
  let buffer = Buffer.alloc(0);
  socket.on("data", (data) => {
    buffer = Buffer.concat([buffer, data]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = buffer.subarray(0, end).toString();
    const length = Number(head.match(/Content-Length: (\d+)/i)?.[1] ?? 0);
    if (buffer.length < end + 4 + length) return;
    buffer = buffer.subarray(end + 4 + length);
    const headers = Object.fromEntries(
      head
        .split("\r\n")
        .slice(1)
        .map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]),
    );
    pending?.({ status: Number(head.split(" ")[1]), headers });
  });
  const request = (method, headers = {}, body = Buffer.alloc(0)) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10000);
      pending = (response) => {
        clearTimeout(timer);
        resolve(response);
      };
      const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const lines = [
        `${method} rtsp://${host}/1234 RTSP/1.0`,
        `CSeq: ${++cseq}`,
        "User-Agent: AirPlay/770.8.1",
        "DACP-ID: 0123456789ABCDEF",
        "Active-Remote: 4242",
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      ];
      if (payload.length) lines.push(`Content-Length: ${payload.length}`);
      socket.write(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), payload]));
    });

  // 1. The receiver must sign challenge + its IP + its "MAC" with the AirPort key.
  const challenge = crypto.randomBytes(16);
  let response = await request("OPTIONS", { "Apple-Challenge": unpadded(challenge) });
  const signed = crypto.publicDecrypt(
    { key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(`${response.headers["apple-response"]}==`, "base64"),
  );
  const ip = Buffer.from(socket.remoteAddress.replace("::ffff:", "").split(".").map(Number));
  const mac = Buffer.from(hardwareId, "hex");
  result.challengeValid = signed.equals(Buffer.concat([challenge, ip, mac, Buffer.alloc(6)]));

  // 2. Hand over the stream key.
  const key = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const wrapped = crypto.publicEncrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, key);
  const sdp = [
    "v=0",
    `o=iTunes 1234 0 IN IP4 ${socket.localAddress}`,
    "s=iTunes",
    `c=IN IP4 ${host}`,
    "t=0 0",
    "m=audio 0 RTP/AVP 96",
    "a=rtpmap:96 AppleLossless",
    "a=fmtp:96 352 0 16 40 10 14 2 255 0 0 44100",
    `a=rsaaeskey:${unpadded(wrapped)}`,
    `a=aesiv:${unpadded(iv)}`,
    "",
  ].join("\r\n");
  result.announce = (await request("ANNOUNCE", { "Content-Type": "application/sdp" }, sdp)).status;

  // 3. Exchange UDP ports.
  const control = dgram.createSocket("udp4");
  const timing = dgram.createSocket("udp4");
  const audio = dgram.createSocket("udp4");
  await Promise.all([control, timing].map((udp) => new Promise((resolve) => udp.bind(0, resolve))));
  response = await request("SETUP", {
    Transport: `RTP/AVP/UDP;unicast;interleaved=0-1;mode=record;control_port=${control.address().port};timing_port=${timing.address().port}`,
  });
  result.setup = response.status;
  const remotePort = (name) => Number(response.headers.transport.match(new RegExp(`${name}=(\\d+)`))[1]);
  const audioPort = remotePort("server_port");
  const controlPort = remotePort("control_port");

  // 4. Start, mute (so nothing is audible), and send song info.
  result.record = (await request("RECORD", { Range: "npt=0-", "RTP-Info": "seq=1000;rtptime=0" })).status;
  await request("SET_PARAMETER", { "Content-Type": "text/parameters" }, "volume: -144.000000\r\n");
  const tag = (name, value) => {
    const data = Buffer.from(value);
    const header = Buffer.alloc(8);
    header.write(name, 0, "latin1");
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
  };
  const dmap = tag("mlit", Buffer.concat([tag("minm", "Test Tone"), tag("asar", "AirPlay Sender"), tag("asal", "Receiver Tests")]));
  await request("SET_PARAMETER", { "Content-Type": "application/x-dmap-tagged" }, dmap);
  await request("SET_PARAMETER", { "Content-Type": "text/parameters" }, `progress: 0/${44100 * 30}/${44100 * 200}\r\n`);

  // 5. Stream ALAC, one packet dropped, answering resend requests.
  const samples = 44100 * seconds;
  const left = new Int32Array(samples);
  for (let i = 0; i < samples; i++) left[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 44100));
  const encoder = createAlacEncoder({ sampleRate: 44100, channels: 2, frameLength: 352 });
  const frames = [...encoder.encode([left, left]), ...encoder.flush()];
  const packets = new Map();
  const makePacket = (seq, frame) => {
    const data = Buffer.from(frame);
    const length = data.length & ~15;
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    cipher.setAutoPadding(false);
    const payload = Buffer.concat([cipher.update(data.subarray(0, length)), cipher.final(), data.subarray(length)]);
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = seq === 1000 ? 0xe0 : 0x60;
    header.writeUInt16BE(seq & 0xffff, 2);
    header.writeUInt32BE(((seq - 1000) * 352) >>> 0, 4);
    header.writeUInt32BE(0x12345678, 8);
    return Buffer.concat([header, payload]);
  };
  result.resent = 0;
  control.on("message", (message) => {
    if ((message[1] & 0x7f) !== 0x55) return;
    const first = message.readUInt16BE(4);
    const count = message.readUInt16BE(6);
    for (let seq = first; seq < first + count; seq++) {
      const packet = packets.get(seq);
      if (!packet) continue;
      result.resent++;
      const wrap = Buffer.from([0x80, 0xd6, 0, 1]);
      control.send(Buffer.concat([wrap, packet]), controlPort, host);
    }
  });

  const DROPPED = 1050;
  const streaming = (async () => {
    const start = Date.now();
    for (let i = 0; i < frames.length; i++) {
      const seq = 1000 + i;
      const packet = makePacket(seq, frames[i]);
      packets.set(seq, packet);
      if (seq !== DROPPED) audio.send(packet, audioPort, host);
      const wait = start + (i * 352 * 1000) / 44100 - 1000 - Date.now(); // ~1 s ahead, like real senders
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 3500));
  result.during = await during();
  await streaming;
  await new Promise((resolve) => setTimeout(resolve, 1000));

  result.teardown = (await request("TEARDOWN")).status;
  socket.destroy();
  control.close();
  timing.close();
  audio.close();
  return result;
}
