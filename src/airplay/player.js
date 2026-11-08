// Audio page for AirPlay: a worklet that plays interleaved 16-bit stereo PCM
// from a ring buffer, waiting for a little audio before starting so network
// jitter doesn't cause dropouts.

"use strict";

const SAMPLE_RATE = 44100;

const WORKLET = `
const CAPACITY = ${SAMPLE_RATE} * 8;        // keep at most 8 s
const START_AFTER = ${SAMPLE_RATE} * 0.35;  // buffer this much before (re)starting
const MAX_BUFFERED = ${SAMPLE_RATE} * 4;    // drift guard: trim if we fall this far behind

class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.size = 0;
    this.playing = false;
    this.gain = 1;
    this.targetGain = 1;
    this.underruns = 0;
    this.blocks = 0;
    this.port.onmessage = (event) => {
      const m = event.data;
      if (m.type === "pcm") this.push(m.pcm);
      else if (m.type === "flush") this.clear();
      else if (m.type === "gain") this.targetGain = m.value;
    };
  }

  clear() {
    this.readIndex = this.writeIndex = this.size = 0;
    this.playing = false;
  }

  push(pcm) {
    const frames = pcm.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.writeIndex] = pcm[2 * i] / 32768;
      this.right[this.writeIndex] = pcm[2 * i + 1] / 32768;
      this.writeIndex = (this.writeIndex + 1) % CAPACITY;
    }
    this.size += frames;
    if (this.size > MAX_BUFFERED) {
      const drop = this.size - START_AFTER;
      this.readIndex = (this.readIndex + drop) % CAPACITY;
      this.size -= drop;
    }
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.playing && this.size >= START_AFTER) this.playing = true;
    for (let i = 0; i < left.length; i++) {
      this.gain += (this.targetGain - this.gain) * 0.002;
      if (this.playing && this.size > 0) {
        left[i] = this.left[this.readIndex] * this.gain;
        right[i] = this.right[this.readIndex] * this.gain;
        this.readIndex = (this.readIndex + 1) % CAPACITY;
        this.size--;
      } else {
        left[i] = right[i] = 0;
        if (this.playing) {
          this.playing = false;
          this.underruns++;
        }
      }
    }
    if (++this.blocks % 172 === 0) {
      // About twice a second.
      this.port.postMessage({
        type: "stats",
        playing: this.playing,
        bufferedMs: Math.round((this.size / sampleRate) * 1000),
        underruns: this.underruns,
      });
    }
    return true;
  }
}

registerProcessor("pcm-player", PcmPlayer);
`;

// Internet radio plays through a plain <audio> element, fed by the app's local
// stream relay (which also reads song titles out of the stream).
function radioPlayer(port) {
  const audio = new Audio();
  audio.preload = "none";
  const report = (state, extra = {}) => port.postMessage({ type: "radio", state, ...extra });
  audio.addEventListener("playing", () => report("playing"));
  audio.addEventListener("waiting", () => report("buffering"));
  audio.addEventListener("stalled", () => report("buffering"));
  audio.addEventListener("ended", () => report("ended"));
  audio.addEventListener("error", () => {
    if (audio.getAttribute("src")) report("error", { message: audio.error?.message || "The stream couldn't be played" });
  });
  return {
    play(url, volume) {
      audio.volume = volume;
      audio.src = url;
      audio.play().catch((error) => report("error", { message: String(error?.message ?? error) }));
      report("buffering");
    },
    stop() {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
    volume(value) {
      audio.volume = value;
    },
  };
}

async function start(port) {
  // Radio uses a plain <audio> element, so wire it up first: it keeps working
  // even if the AirPlay worklet below can't start (e.g. no audio device yet).
  const radio = radioPlayer(port);
  let node = null;
  let context = null;
  let pendingGain = null;
  port.onmessage = (event) => {
    const message = event.data;
    if (message.type === "radio-play") return radio.play(message.url, message.volume);
    if (message.type === "radio-stop") return radio.stop();
    if (message.type === "radio-volume") return radio.volume(message.value);
    if (!node) {
      if (message.type === "gain") pendingGain = message; // apply once ready
      return;
    }
    if (context.state !== "running") context.resume();
    if (message.type === "pcm") node.port.postMessage(message, [message.pcm.buffer]);
    else node.port.postMessage(message);
  };
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "playback" });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await context.audioWorklet.addModule(url);
    const worklet = new AudioWorkletNode(context, "pcm-player", { outputChannelCount: [2] });
    worklet.connect(context.destination);
    worklet.port.onmessage = (event) => port.postMessage(event.data);
    node = worklet;
    if (pendingGain) node.port.postMessage(pendingGain);
  } catch (error) {
    port.postMessage({ type: "error", message: String(error?.message ?? error) });
  }
}

window.addEventListener("message", (event) => {
  if (event.data === "audio-port" && event.ports[0]) start(event.ports[0]);
});
