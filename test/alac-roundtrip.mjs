// The ALAC decoder must reproduce PCM bit for bit: ALAC is lossless, so encoding
// known samples with an independent port of Apple's encoder gives an exact oracle.

import { createRequire } from "node:module";
import { createAlacEncoder } from "@audio/encode-alac/core";

const require = createRequire(import.meta.url);
const { createDecoder } = require("../src/airplay/alac.js");

function configFromCookie(cookie) {
  const view = new DataView(cookie.buffer, cookie.byteOffset, cookie.byteLength);
  return {
    frameLength: view.getUint32(0),
    compatibleVersion: cookie[4],
    bitDepth: cookie[5],
    pb: cookie[6],
    mb: cookie[7],
    kb: cookie[8],
    numChannels: cookie[9],
    maxRun: view.getUint16(10),
  };
}

let seed = 12345;
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 2 - 1;
const clamp = (value) => Math.max(-32768, Math.min(32767, Math.round(value)));

function signal(kind, length, channels) {
  const out = Array.from({ length: channels }, () => new Int32Array(length));
  for (let i = 0; i < length; i++) {
    const t = i / 44100;
    for (let c = 0; c < channels; c++) {
      let value = 0;
      if (kind === "music") {
        const envelope = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.3));
        value = envelope * (9000 * Math.sin(2 * Math.PI * (220 + c * 3) * t) + 5000 * Math.sin(2 * Math.PI * 659 * t + c)) + 400 * random();
        if (i > length * 0.4 && i < length * 0.5) value = 0; // zero runs
        if (i > length * 0.6 && i < length * 0.62) value = 32767 * random(); // forces uncompressed frames
      } else if (kind === "noise") value = 32767 * random();
      else if (kind === "square") value = Math.sin(2 * Math.PI * 100 * t) > 0 ? 32767 : -32768;
      out[c][i] = clamp(value);
    }
  }
  return out;
}

let failures = 0;
const cases = [["music", 2, false], ["music", 2, true], ["noise", 2, false], ["silence", 2, false], ["square", 2, false], ["music", 1, false], ["noise", 1, false]];
for (const [kind, channels, fastMode] of cases) {
  const length = 44100 * 2 + 123; // leaves a partial final frame
  const pcm = signal(kind, length, channels);
  const encoder = createAlacEncoder({ sampleRate: 44100, channels, bitDepth: 16, frameLength: 352, fastMode });
  const frames = [...encoder.encode(pcm), ...encoder.flush()];
  const decoder = createDecoder(configFromCookie(encoder.cookie));
  let offset = 0;
  let mismatches = 0;
  for (const frame of frames) {
    const out = decoder.decode(frame);
    const count = out.length / channels;
    for (let i = 0; i < count; i++) {
      for (let c = 0; c < channels; c++) if (out[i * channels + c] !== pcm[c][offset + i]) mismatches++;
    }
    offset += count;
  }
  const ok = mismatches === 0 && offset === length;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${kind} channels=${channels} fast=${fastMode} frames=${frames.length} mismatches=${mismatches}`);
}
process.exit(failures ? 1 : 0);
