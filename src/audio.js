/**
 * Procedural Web Audio soundscape. All sounds are synthesized, not recordings
 * of DPP vehicles. Call start() from a click/keyboard handler before update().
 */

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const number = (value, fallback = 0) =>
  Number.isFinite(value) ? value : fallback;

export class TramAudio {
  constructor(options = {}) {
    this.volume = clamp(number(options.volume, 0.65), 0, 1);
    this.muted = Boolean(options.muted);
    this.context = null;
    this.started = false;
    this.disposed = false;
    this._nodes = [];
    this._sources = [];
    this._noiseBuffer = null;
    this._lastJoint = null;
    this._lastJointTime = -1;
    this._speechActive = false;
    this._utterance = null;
    this._lastAnnouncement = "";
    this._lastAnnouncementTime = -100;
  }

  async start() {
    if (this.disposed) return false;
    const browser = typeof window === "undefined" ? null : window;
    const AudioContextClass =
      browser?.AudioContext || browser?.webkitAudioContext;
    if (!AudioContextClass) return false;
    if (!this.context) {
      // Creating/resuming the context happens before the first await, preserving
      // the originating user activation in browsers with autoplay protection.
      const ctx = (this.context = new AudioContextClass());
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.compressor = ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -15;
      this.compressor.knee.value = 12;
      this.compressor.ratio.value = 3.5;
      this.compressor.attack.value = 0.006;
      this.compressor.release.value = 0.2;
      this.compressor.connect(this.master);
      this.master.connect(ctx.destination);
      this._nodes.push(this.master, this.compressor);
      this._noiseBuffer = this._makeNoise(2.4);

      this.motorFilter = ctx.createBiquadFilter();
      this.motorFilter.type = "lowpass";
      this.motorFilter.frequency.value = 850;
      this.motorFilter.Q.value = 0.45;
      this.motorGain = ctx.createGain();
      this.motorGain.gain.value = 0;
      this.motorFilter.connect(this.motorGain);
      this.motorGain.connect(this.compressor);
      this.motor = ctx.createOscillator();
      this.motor.type = "sawtooth";
      this.motor.frequency.value = 48;
      this.motor.connect(this.motorFilter);
      this.motor.start();
      this.motorHarmonic = ctx.createOscillator();
      this.motorHarmonic.type = "triangle";
      this.motorHarmonic.frequency.value = 97;
      this.harmonicGain = ctx.createGain();
      this.harmonicGain.gain.value = 0;
      this.motorHarmonic.connect(this.harmonicGain);
      this.harmonicGain.connect(this.compressor);

      this.motorHarmonic.start();
      this.railFilter = ctx.createBiquadFilter();
      this.railFilter.type = "lowpass";
      this.railFilter.frequency.value = 160;
      this.railFilter.Q.value = 0.7;
      this.railGain = ctx.createGain();
      this.railGain.gain.value = 0;
      this.railNoise = ctx.createBufferSource();
      this.railNoise.buffer = this._noiseBuffer;
      this.railNoise.loop = true;
      this.railNoise.connect(this.railFilter);
      this.railFilter.connect(this.railGain);
      this.railGain.connect(this.compressor);
      this.railNoise.start();

      this.hissFilter = ctx.createBiquadFilter();
      this.hissFilter.type = "bandpass";
      this.hissFilter.frequency.value = 1700;
      this.hissFilter.Q.value = 0.45;
      this.hissGain = ctx.createGain();
      this.hissGain.gain.value = 0;
      this.hissNoise = ctx.createBufferSource();
      this.hissNoise.buffer = this._noiseBuffer;
      this.hissNoise.loop = true;
      this.hissNoise.connect(this.hissFilter);
      this.hissFilter.connect(this.hissGain);
      this.hissGain.connect(this.compressor);
      this.hissNoise.start(0, 0.93);

      this._nodes.push(
        this.motorFilter,
        this.motorGain,
        this.harmonicGain,
        this.railFilter,
        this.railGain,
        this.hissFilter,
        this.hissGain,
      );
      this._sources.push(
        this.motor,
        this.motorHarmonic,
        this.railNoise,
        this.hissNoise,
      );
    }
    try {
      if (this.context.state === "suspended") await this.context.resume();
      this.started = this.context.state === "running";
    } catch {
      this.started = false;
    }
    return this.started;
  }

  _makeNoise(duration) {
    const ctx = this.context;
    const buffer = ctx.createBuffer(
      1,
      Math.round(ctx.sampleRate * duration),
      ctx.sampleRate,
    );
    const channel = buffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < channel.length; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + white * 0.025) / 1.025;
      channel[i] = white * 0.45 + brown * 2;
    }
    return buffer;
  }

  update(snapshot, dt = 1 / 60) {
    if (
      !this.started ||
      this.disposed ||
      !snapshot ||
      this.context.state !== "running"
    )
      return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const speed = clamp(
      number(snapshot.speedKmh, number(snapshot.speed) * 3.6),
      0,
      80,
    );
    const normalized = clamp(speed / 65, 0, 1);
    const controller = clamp(number(snapshot.throttle), -1, 1);
    const motion = Math.min(1, speed / 4);
    const power =
      snapshot.doors || number(snapshot.doorProgress) > 0
        ? 0
        : Math.abs(controller);
    const duck = this._speechActive ? 0.48 : 1;
    const ramp = clamp(number(dt, 1 / 60) * 3, 0.025, 0.12);
    const frequency = 48 + speed * 4.1;
    this.motor.frequency.setTargetAtTime(frequency, now, 0.11);
    this.motorHarmonic.frequency.setTargetAtTime(frequency * 2.025, now, 0.11);
    this.motorFilter.frequency.setTargetAtTime(500 + speed * 19, now, 0.14);
    this.motorGain.gain.setTargetAtTime(
      motion * (0.012 + power * 0.061) * duck,
      now,
      ramp,
    );
    this.harmonicGain.gain.setTargetAtTime(
      motion * (0.005 + power * 0.014) * duck,
      now,
      ramp,
    );
    this.railFilter.frequency.setTargetAtTime(110 + speed * 8.5, now, 0.14);
    this.railGain.gain.setTargetAtTime(
      motion * (0.016 + normalized * 0.13) * duck,
      now,
      ramp,
    );
    this.hissFilter.frequency.setTargetAtTime(1300 + speed * 12, now, 0.15);
    this.hissGain.gain.setTargetAtTime(
      motion *
        (0.003 +
          normalized * 0.023 +
          (snapshot.weather === "rain" ? 0.014 : 0)) *
        duck,
      now,
      ramp,
    );

    const position = number(snapshot.s);
    const joint = Math.floor(position / 12);
    if (
      this._lastJoint !== null &&
      joint !== this._lastJoint &&
      Math.abs(joint - this._lastJoint) < 3 &&
      speed > 4 &&
      now - this._lastJointTime > 0.11
    ) {
      this._wheelJoint(normalized);
      this._lastJointTime = now;
    }
    this._lastJoint = joint;
  }

  _transient(source, gain, endTime, nodes = []) {
    source.start();
    source.stop(endTime);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      for (const node of nodes) node.disconnect();
    };
  }

  _wheelJoint(speed) {
    if (this.muted) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 180;
    filter.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.045 + speed * 0.05, now + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.105);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.compressor);
    this._transient(source, gain, now + 0.12, [filter]);
  }

  bell() {
    if (!this.started || this.muted || this.disposed) return false;
    const ctx = this.context;
    const now = ctx.currentTime;
    // Two strikes, with deliberately inharmonic partials for a metal bell.
    for (const delay of [0, 0.16]) {
      for (const [frequency, level, decay] of [
        [1810, 0.16, 0.75],
        [2783, 0.065, 0.42],
        [4190, 0.025, 0.22],
      ]) {
        const oscillator = ctx.createOscillator();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        const gain = ctx.createGain();
        const start = now + delay;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.linearRampToValueAtTime(level, start + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
        oscillator.connect(gain);
        gain.connect(this.compressor);
        this._transient(oscillator, gain, start + decay + 0.03);
      }
    }
    return true;
  }

  doors(open) {
    if (!this.started || this.muted || this.disposed) return false;
    const ctx = this.context;
    const now = ctx.currentTime;
    const duration = open ? 0.95 : 1.22;
    const source = ctx.createBufferSource();
    source.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(open ? 780 : 920, now);
    filter.frequency.linearRampToValueAtTime(420, now + duration);
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.13, now + 0.055);
    gain.gain.linearRampToValueAtTime(0.07, now + duration - 0.13);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.compressor);
    this._transient(source, gain, now + duration + 0.03, [filter]);

    const servo = ctx.createOscillator();
    servo.type = "triangle";
    servo.frequency.setValueAtTime(open ? 230 : 270, now);
    servo.frequency.linearRampToValueAtTime(145, now + duration);
    const servoGain = ctx.createGain();
    servoGain.gain.setValueAtTime(0.0001, now);
    servoGain.gain.linearRampToValueAtTime(0.015, now + 0.06);
    servoGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    servo.connect(servoGain);
    servoGain.connect(this.compressor);
    this._transient(servo, servoGain, now + duration + 0.03);
    if (!open) {
      for (const delay of [0, 0.23, 0.46]) {
        const tone = ctx.createOscillator();
        tone.type = "sine";
        tone.frequency.value = 880;
        const toneGain = ctx.createGain();
        toneGain.gain.setValueAtTime(0.0001, now);
        toneGain.gain.setValueAtTime(0.0001, now + delay);
        toneGain.gain.linearRampToValueAtTime(0.07, now + delay + 0.012);
        toneGain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.14);
        tone.connect(toneGain);
        toneGain.connect(this.compressor);
        this._transient(tone, toneGain, now + delay + 0.17);
      }
    }
    return true;
  }

  announce(text) {
    if (
      this.muted ||
      this.disposed ||
      typeof window === "undefined" ||
      !window.speechSynthesis ||
      !window.SpeechSynthesisUtterance
    )
      return false;
    const content = String(text || "").trim();
    if (!content) return false;
    const clock = this.context?.currentTime || Date.now() / 1000;
    if (
      content === this._lastAnnouncement &&
      clock - this._lastAnnouncementTime < 4
    )
      return false;
    this._lastAnnouncement = content;
    this._lastAnnouncementTime = clock;
    const utterance = new window.SpeechSynthesisUtterance(content);
    utterance.lang = "cs-CZ";
    utterance.rate = 0.92;
    utterance.pitch = 1;
    utterance.volume = Math.min(0.9, this.volume + 0.15);
    const voice = window.speechSynthesis
      .getVoices()
      .find((item) => item.lang.toLowerCase().startsWith("cs"));
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      this._speechActive = true;
    };
    const finished = () => {
      if (this._utterance === utterance) {
        this._speechActive = false;
        this._utterance = null;
      }
    };
    utterance.onend = finished;
    utterance.onerror = finished;
    this._utterance = utterance;
    window.speechSynthesis.speak(utterance);
    return true;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.context && this.master) {
      this.master.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.context.currentTime,
        0.035,
      );
    }
    if (this.muted && this._utterance && typeof window !== "undefined") {
      window.speechSynthesis?.cancel();
      this._utterance = null;
      this._speechActive = false;
    }
    return this.muted;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.started = false;
    if (this._utterance && typeof window !== "undefined")
      window.speechSynthesis?.cancel();
    for (const source of this._sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* detached */
      }
    }
    for (const node of this._nodes) {
      try {
        node.disconnect();
      } catch {
        /* detached */
      }
    }
    if (this.context && this.context.state !== "closed")
      this.context.close().catch(() => {});
    this._sources = [];
    this._nodes = [];
    this._noiseBuffer = null;
    this._utterance = null;
  }
}
