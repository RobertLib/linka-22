import assert from "node:assert/strict";
import { TramAudio } from "../src/audio.js";

class AudioParamMock {
  constructor() {
    this.value = 0;
    this.events = [];
  }
  setValueAtTime(value, time) {
    this.events.push({ method: "set", value, time });
  }
  setTargetAtTime(value, time) {
    this.events.push({ method: "target", value, time });
  }
  linearRampToValueAtTime(value, time) {
    this.events.push({ method: "linear", value, time });
  }
  exponentialRampToValueAtTime(value, time) {
    assert.ok(value > 0, "exponential audio ramps must remain positive");
    this.events.push({ method: "exponential", value, time });
  }
}

class AudioNodeMock {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
    for (const key of [
      "gain",
      "frequency",
      "Q",
      "threshold",
      "knee",
      "ratio",
      "attack",
      "release",
    ]) {
      this[key] = new AudioParamMock();
    }
  }
  connect(node) {
    this.connections.push(node);
  }
  disconnect() {
    this.disconnected = true;
  }
  start(time = 0) {
    this.startTime = time;
  }
  stop(time) {
    this.stopTime = time;
  }
}

class AudioContextMock {
  constructor() {
    this.currentTime = 0;
    this.sampleRate = 1000;
    this.state = "running";
    this.destination = new AudioNodeMock("destination");
    this.nodes = [];
  }
  node(kind) {
    const node = new AudioNodeMock(kind);
    this.nodes.push(node);
    return node;
  }
  createGain() {
    return this.node("gain");
  }
  createDynamicsCompressor() {
    return this.node("compressor");
  }
  createBiquadFilter() {
    return this.node("filter");
  }
  createOscillator() {
    return this.node("oscillator");
  }
  createBufferSource() {
    return this.node("buffer-source");
  }
  createBuffer(channels, length) {
    const channel = new Float32Array(length);
    return { getChannelData: () => channel };
  }
  async close() {
    this.state = "closed";
  }
}

globalThis.window = { AudioContext: AudioContextMock };
const audio = new TramAudio();
assert.equal(await audio.start(), true);
const ctx = audio.context;
const snapshot = (count, time, energy = 5, extras = {}) => ({
  collisionCount: count,
  time,
  speed: 0,
  s: 0,
  lastCollisionImpact: count ? { time, dissipatedEnergyKJ: energy } : null,
  ...extras,
});
const update = (state) => {
  const before = ctx.nodes.length;
  ctx.currentTime += 0.1;
  audio.update(state);
  return ctx.nodes.slice(before);
};
const gains = (nodes) => nodes.filter((node) => node.kind === "gain");
const peak = (node) =>
  Math.max(...node.gain.events.map((event) => event.value));
const sources = (nodes) => nodes.filter((node) => node.startTime !== undefined);

assert.equal(
  update(snapshot(2, 10)).length,
  0,
  "restored collisions stay silent",
);
const gentle = update(snapshot(3, 11));
assert.equal(
  sources(gentle).length,
  3,
  "impact includes crush, body thud and metal rattle",
);
assert.equal(
  update(snapshot(3, 11)).length,
  0,
  "same collision does not repeat",
);
for (const source of sources(gentle)) {
  assert.ok(
    source.stopTime > ctx.currentTime,
    "impact sources have finite lifetimes",
  );
  source.onended();
  assert.equal(source.disconnected, true);
}
assert.ok(
  gains(gentle).every((gain) => gain.disconnected),
  "impact gains release after playback",
);
assert.equal(
  update(
    snapshot(3, 11.1, 2, {
      lastCollisionImpact: {
        time: 11.1,
        dissipatedEnergyKJ: 2,
        continuingContact: true,
      },
    }),
  ).length,
  0,
  "sustained physical contact does not replay the crash sound",
);

const strong = update(snapshot(4, 12, 180));
assert.ok(
  peak(gains(strong)[0]) > peak(gains(gentle)[0]) * 2,
  "harder impacts sound louder",
);
audio.setMuted(true);
assert.equal(
  update(snapshot(5, 13)).length,
  0,
  "muted impacts do not allocate sources",
);
audio.setMuted(false);
assert.equal(
  update(snapshot(5, 13)).length,
  0,
  "unmuting does not replay impact",
);
assert.equal(
  update(snapshot(6, 14, 5, { paused: true })).length,
  0,
  "paused events stay silent",
);
assert.equal(
  update(snapshot(6, 14)).length,
  0,
  "resuming does not replay impact",
);
assert.equal(update(snapshot(0, 0)).length, 0, "service reset stays silent");
assert.equal(
  sources(update(snapshot(1, 1))).length,
  3,
  "new service can play its first impact",
);
assert.equal(
  update(snapshot(4, 0.5)).length,
  0,
  "rewinding to a saved service stays silent",
);

// The event timestamp also supports callers that have no cumulative count.
const fallback = new TramAudio();
assert.equal(await fallback.start(), true);
fallback.update({ lastCollision: { time: 1, deltaSpeedMps: -0.2 } });
const initialNodes = fallback.context.nodes.length;
fallback.update({ lastCollision: { time: 2, deltaSpeedMps: -0.2 } });
assert.ok(
  fallback.context.nodes.length > initialNodes,
  "timestamp detects an impact without a counter",
);
const eventNodes = fallback.context.nodes.length;
fallback.update({ lastCollision: { time: 2, deltaSpeedMps: -0.2 } });
assert.equal(
  fallback.context.nodes.length,
  eventNodes,
  "timestamp event is played once",
);
fallback.dispose();
audio.dispose();
delete globalThis.window;
console.log("Collision audio checks passed.");
