// Apple Lossless (ALAC) decoder for AirPlay audio.
//
// A JavaScript port of Apple's reference ALAC decoder (ALACDecoder.cpp,
// ag_dec.c, dp_dec.c, matrix_dec.c, ALACBitUtilities.c),
// Copyright (c) 2011 Apple Inc., Apache License 2.0:
// https://github.com/macosforge/alac. See NOTICE.
//
// Only what AirPlay senders use is supported: 16-bit samples, mono or
// stereo. Output is interleaved signed 16-bit PCM.

"use strict";

// aglib.h
const QBSHIFT = 9;
const QB = 1 << QBSHIFT;
const MMULSHIFT = 2;
const MDENSHIFT = QBSHIFT - MMULSHIFT - 1;
const MOFF = 1 << (MDENSHIFT - 2);
const BITOFF = 24;
const MAX_PREFIX_16 = 9;
const MAX_PREFIX_32 = 9;
const MAX_DATATYPE_BITS_16 = 16;
const N_MAX_MEAN_CLAMP = 0xffff;
const N_MEAN_CLAMP_VAL = 0xffff;

// ALACAudioTypes.h element tags
const ID_SCE = 0;
const ID_CPE = 1;
const ID_CCE = 2;
const ID_LFE = 3;
const ID_DSE = 4;
const ID_PCE = 5;
const ID_FIL = 6;
const ID_END = 7;

class DecodeError extends Error {}

// ---------------------------------------------------------------- bit buffer

class BitBuffer {
  constructor(bytes) {
    // Pad so 32-bit look-ahead reads near the end stay in bounds.
    this.data = new Uint8Array(bytes.length + 8);
    this.data.set(bytes);
    this.size = bytes.length;
    this.byte = 0;
    this.bit = 0;
  }

  get position() {
    return this.byte * 8 + this.bit;
  }

  check() {
    if (this.byte > this.size) throw new DecodeError("read past end of frame");
  }

  read(n) {
    // BitBufferRead: up to 16 bits.
    const d = this.data;
    const i = this.byte;
    let v = ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) << this.bit;
    v &= 0xffffff;
    this.bit += n;
    v >>>= 24 - n;
    this.byte += this.bit >> 3;
    this.bit &= 7;
    return v;
  }

  readSmall(n) {
    // BitBufferReadSmall: up to 8 bits.
    const d = this.data;
    let v = (((d[this.byte] << 8) | d[this.byte + 1]) << this.bit) & 0xffff;
    this.bit += n;
    v >>>= 16 - n;
    this.byte += this.bit >> 3;
    this.bit &= 7;
    return v & 0xff;
  }

  readOne() {
    const v = (this.data[this.byte] >> (7 - this.bit)) & 1;
    this.advance(1);
    return v;
  }

  advance(n) {
    if (!n) return;
    this.bit += n;
    this.byte += this.bit >> 3;
    this.bit &= 7;
  }

  byteAlign() {
    if (this.bit !== 0) this.advance(8 - this.bit);
  }
}

// ---------------------------------------------------------------- ag_dec.c

function lead(m) {
  return m === 0 ? 32 : Math.clz32(m);
}

function lg3a(x) {
  return 31 - lead(x + 3);
}

function read32(d, i) {
  return ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
}

function getStreamBits(d, bitOffset, numBits) {
  const byteOffset = bitOffset >>> 3;
  const load1 = read32(d, byteOffset);
  let result;
  if (numBits + (bitOffset & 7) > 32) {
    result = (load1 << (bitOffset & 7)) >>> 0;
    const load2 = d[byteOffset + 4] >>> (8 - (numBits + (bitOffset & 7) - 32));
    result = ((result >>> (32 - numBits)) | load2) >>> 0;
  } else {
    result = load1 >>> (32 - numBits - (bitOffset & 7));
  }
  if (numBits !== 32) result = (result & ~(0xffffffff << numBits)) >>> 0;
  return result;
}

/** Reads one adaptive-Golomb value for a zero run (dyn_get). */
function dynGet(d, pos, m, k) {
  let bits = pos.value;
  let stream = (read32(d, bits >>> 3) << (bits & 7)) >>> 0;
  let pre = lead(~stream >>> 0);
  let result;
  if (pre >= MAX_PREFIX_16) {
    pre = MAX_PREFIX_16;
    bits += pre;
    stream = (stream << pre) >>> 0;
    result = stream >>> (32 - MAX_DATATYPE_BITS_16);
    bits += MAX_DATATYPE_BITS_16;
  } else {
    bits += pre + 1;
    stream = (pre + 1 >= 32 ? 0 : stream << (pre + 1)) >>> 0;
    const v = k === 0 ? 0 : stream >>> (32 - k);
    bits += k;
    result = pre * m + v - 1;
    if (v < 2) {
      result -= v - 1;
      bits -= 1;
    }
  }
  pos.value = bits;
  return result >>> 0;
}

/** Reads one adaptive-Golomb sample value (dyn_get_32bit). */
function dynGet32(d, pos, m, k, maxBits) {
  let bits = pos.value;
  let stream = (read32(d, bits >>> 3) << (bits & 7)) >>> 0;
  let result = lead(~stream >>> 0);
  if (result >= MAX_PREFIX_32) {
    result = getStreamBits(d, bits + MAX_PREFIX_32, maxBits);
    bits += MAX_PREFIX_32 + maxBits;
  } else {
    bits += result + 1;
    if (k !== 1) {
      stream = (result + 1 >= 32 ? 0 : stream << (result + 1)) >>> 0;
      const v = stream >>> (32 - k);
      bits += k - 1;
      result = result * m;
      if (v >= 2) {
        result += v - 1;
        bits += 1;
      }
    }
  }
  pos.value = bits;
  return result >>> 0;
}

function dynDecomp(params, bb, out, numSamples, maxSize) {
  const d = bb.data;
  const start = bb.position;
  const maxPos = bb.size * 8;
  const pos = { value: start };
  const { pb, kb, wb } = params;
  let mb = params.mb0;
  let zmode = 0;
  let c = 0;
  let o = 0;

  while (c < numSamples) {
    if (pos.value >= maxPos) throw new DecodeError("ran out of bits");
    let m = mb >>> QBSHIFT;
    let k = Math.min(lg3a(m), kb);
    m = (1 << k) - 1;
    const n = dynGet32(d, pos, m, k, maxSize);

    const ndecode = n + zmode;
    const multiplier = -(ndecode & 1) | 1;
    out[o++] = ((ndecode + 1) >>> 1) * multiplier;
    c++;

    mb = (pb * (n + zmode) + mb - ((pb * mb) >>> QBSHIFT)) >>> 0;
    if (n > N_MAX_MEAN_CLAMP) mb = N_MEAN_CLAMP_VAL;

    zmode = 0;
    if ((mb << MMULSHIFT) >>> 0 < QB && c < numSamples) {
      zmode = 1;
      k = lead(mb) - BITOFF + ((mb + MOFF) >> MDENSHIFT);
      const mz = ((1 << k) - 1) & wb;
      const run = dynGet(d, pos, mz, k);
      if (c + run > numSamples) throw new DecodeError("zero run past end of frame");
      for (let j = 0; j < run; j++) {
        out[o++] = 0;
        c++;
      }
      if (run >= 65535) zmode = 0;
      mb = 0;
    }
  }

  bb.advance(pos.value - start);
  bb.check();
}

// ---------------------------------------------------------------- dp_dec.c

function signOf(i) {
  return ((-i >>> 0) >>> 31) | (i >> 31);
}

/** Undoes the adaptive linear predictor (unpc_block). */
function unpcBlock(pc, out, num, coefs, numActive, chanBits, denShift) {
  const chanShift = 32 - chanBits;
  const denHalf = 1 << (denShift - 1);
  out[0] = pc[0];

  if (numActive === 0) {
    if (num > 1 && pc !== out) out.set(pc.subarray(1, num), 1);
    return;
  }
  if (numActive === 31) {
    let prev = out[0];
    for (let j = 1; j < num; j++) {
      const del = (pc[j] + prev) | 0;
      prev = (del << chanShift) >> chanShift;
      out[j] = prev;
    }
    return;
  }

  for (let j = 1; j <= numActive; j++) {
    const del = (pc[j] + out[j - 1]) | 0;
    out[j] = (del << chanShift) >> chanShift;
  }

  const lim = numActive + 1;
  for (let j = lim; j < num; j++) {
    const top = out[j - lim];
    const p = j - 1; // out[p - k] == pout[-k]
    let sum = 0;
    for (let k = 0; k < numActive; k++) sum = (sum + Math.imul(coefs[k], (out[p - k] - top) | 0)) | 0;
    let del = pc[j];
    let del0 = del;
    const sg = signOf(del);
    del = (del + top + ((sum + denHalf) >> denShift)) | 0;
    out[j] = (del << chanShift) >> chanShift;

    if (sg > 0) {
      for (let k = numActive - 1; k >= 0; k--) {
        const dd = (top - out[p - k]) | 0;
        const sgn = signOf(dd);
        coefs[k] -= sgn; // Int16Array wraps like int16_t
        del0 = (del0 - Math.imul(numActive - k, Math.imul(sgn, dd) >> denShift)) | 0;
        if (del0 <= 0) break;
      }
    } else if (sg < 0) {
      for (let k = numActive - 1; k >= 0; k--) {
        const dd = (top - out[p - k]) | 0;
        const sgn = signOf(dd);
        coefs[k] += sgn;
        del0 = (del0 - Math.imul(numActive - k, Math.imul(-sgn, dd) >> denShift)) | 0;
        if (del0 >= 0) break;
      }
    }
  }
}

// ---------------------------------------------------------------- decoder

/**
 * @param {{ frameLength: number, bitDepth: number, pb: number, mb: number, kb: number,
 *           numChannels: number, maxRun: number }} config
 */
function createDecoder(config) {
  if (config.bitDepth !== 16) throw new Error(`Unsupported ALAC bit depth ${config.bitDepth}`);
  const frameLength = config.frameLength;
  const mixU = new Int32Array(frameLength);
  const mixV = new Int32Array(frameLength);
  const predictor = new Int32Array(frameLength);
  const coefsU = new Int16Array(32);
  const coefsV = new Int16Array(32);

  function agParams(pbFactor, numSamples) {
    const kb = config.kb;
    return {
      mb0: config.mb,
      pb: Math.floor((config.pb * pbFactor) / 4),
      kb,
      wb: (1 << kb) - 1,
      fw: numSamples,
      sw: numSamples,
      maxRun: config.maxRun,
    };
  }

  function decodeChannel(bb, out, mode, denShift, pbFactor, coefs, numCoefs, numSamples, chanBits) {
    dynDecomp(agParams(pbFactor, numSamples), bb, predictor, numSamples, chanBits);
    if (mode === 0) {
      unpcBlock(predictor, out, numSamples, coefs, numCoefs, chanBits, denShift);
    } else {
      unpcBlock(predictor, predictor, numSamples, null, 31, chanBits, 0);
      unpcBlock(predictor, out, numSamples, coefs, numCoefs, chanBits, denShift);
    }
  }

  function readCoefs(bb, coefs) {
    let header = bb.read(8);
    const mode = header >> 4;
    const denShift = header & 0xf;
    header = bb.read(8);
    const pbFactor = header >> 5;
    const count = header & 0x1f;
    for (let i = 0; i < count; i++) coefs[i] = bb.read(16); // Int16Array makes it signed
    return { mode, denShift, pbFactor, count };
  }

  /**
   * @param {Uint8Array} frame one ALAC packet
   * @returns {Int16Array} interleaved PCM, numChannels per sample
   */
  function decode(frame) {
    const channels = config.numChannels;
    const bb = new BitBuffer(frame);
    let numSamples = frameLength;
    let channelIndex = 0;
    let out = new Int16Array(numSamples * channels);

    const ensureLength = (n) => {
      if (n > frameLength) throw new DecodeError("frame longer than configured");
      if (out.length !== n * channels) out = new Int16Array(n * channels);
    };

    for (;;) {
      if (bb.byte >= bb.size) throw new DecodeError("missing END element");
      const tag = bb.readSmall(3);

      if (tag === ID_SCE || tag === ID_LFE) {
        bb.readSmall(4); // element instance tag
        if (bb.read(12) !== 0) throw new DecodeError("bad element header");
        const header = bb.read(4);
        const partial = header >> 3;
        const bytesShifted = (header >> 1) & 3;
        if (bytesShifted === 3) throw new DecodeError("bad shift");
        const escape = header & 1;
        const chanBits = config.bitDepth - bytesShifted * 8;
        if (partial) numSamples = ((bb.read(16) << 16) | bb.read(16)) >>> 0;
        ensureLength(numSamples);

        if (!escape) {
          bb.read(8); // mixBits
          bb.read(8); // mixRes
          const u = readCoefs(bb, coefsU);
          if (bytesShifted) bb.advance(bytesShifted * 8 * numSamples); // low bytes unused at 16-bit
          decodeChannel(bb, mixU, u.mode, u.denShift, u.pbFactor, coefsU, u.count, numSamples, chanBits);
        } else {
          const shift = 32 - chanBits;
          for (let i = 0; i < numSamples; i++) mixU[i] = (bb.read(chanBits) << shift) >> shift;
        }
        for (let i = 0, j = channelIndex; i < numSamples; i++, j += channels) out[j] = mixU[i];
        channelIndex += 1;
      } else if (tag === ID_CPE) {
        if (channelIndex + 2 > channels) break;
        bb.readSmall(4);
        if (bb.read(12) !== 0) throw new DecodeError("bad element header");
        const header = bb.read(4);
        const partial = header >> 3;
        const bytesShifted = (header >> 1) & 3;
        if (bytesShifted === 3) throw new DecodeError("bad shift");
        const escape = header & 1;
        let chanBits = config.bitDepth - bytesShifted * 8 + 1;
        if (partial) numSamples = ((bb.read(16) << 16) | bb.read(16)) >>> 0;
        ensureLength(numSamples);

        let mixBits = 0;
        let mixRes = 0;
        if (!escape) {
          mixBits = bb.read(8);
          mixRes = (bb.read(8) << 24) >> 24; // int8
          const u = readCoefs(bb, coefsU);
          const v = readCoefs(bb, coefsV);
          if (bytesShifted) bb.advance(bytesShifted * 8 * 2 * numSamples);
          decodeChannel(bb, mixU, u.mode, u.denShift, u.pbFactor, coefsU, u.count, numSamples, chanBits);
          decodeChannel(bb, mixV, v.mode, v.denShift, v.pbFactor, coefsV, v.count, numSamples, chanBits);
        } else {
          chanBits = config.bitDepth;
          const shift = 32 - chanBits;
          for (let i = 0; i < numSamples; i++) {
            mixU[i] = (bb.read(chanBits) << shift) >> shift;
            mixV[i] = (bb.read(chanBits) << shift) >> shift;
          }
        }

        // unmix16
        for (let i = 0, j = channelIndex; i < numSamples; i++, j += channels) {
          if (mixRes !== 0) {
            const l = (mixU[i] + mixV[i] - (Math.imul(mixRes, mixV[i]) >> mixBits)) | 0;
            out[j] = l;
            out[j + 1] = l - mixV[i];
          } else {
            out[j] = mixU[i];
            out[j + 1] = mixV[i];
          }
        }
        channelIndex += 2;
      } else if (tag === ID_DSE) {
        bb.readSmall(4);
        const align = bb.readOne();
        let count = bb.readSmall(8);
        if (count === 255) count += bb.readSmall(8);
        if (align) bb.byteAlign();
        bb.advance(count * 8);
        bb.check();
      } else if (tag === ID_FIL) {
        let count = bb.readSmall(4);
        if (count === 15) count += bb.readSmall(8) - 1;
        bb.advance(count * 8);
        bb.check();
      } else if (tag === ID_END) {
        bb.byteAlign();
        break;
      } else {
        // ID_CCE / ID_PCE aren't used by ALAC.
        throw new DecodeError(`unsupported element ${tag}`);
      }

      if (channelIndex >= channels) break;
    }
    return out;
  }

  return { decode, config };
}

/** Parses the SDP fmtp line AirPlay senders use: "96 352 0 16 40 10 14 2 255 0 0 44100". */
function configFromFmtp(fmtp) {
  const f = fmtp.trim().split(/\s+/).map(Number);
  return {
    frameLength: f[1],
    compatibleVersion: f[2],
    bitDepth: f[3],
    pb: f[4],
    mb: f[5],
    kb: f[6],
    numChannels: f[7],
    maxRun: f[8],
    maxFrameBytes: f[9],
    avgBitRate: f[10],
    sampleRate: f[11],
  };
}

module.exports = { createDecoder, configFromFmtp, DecodeError, ID_CCE, ID_PCE };
