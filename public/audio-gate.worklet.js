/**
 * AudioWorklet: runs on the audio render thread (never blocks the UI).
 * Job: an adaptive energy gate. Silence / low-level room noise never reaches the
 * speech recogniser, which (a) saves CPU and (b) removes a whole class of
 * hallucinated commands.
 *
 * Messages OUT:  {t:'start'} {t:'audio', buf:Float32Array} {t:'end', ms}
 *                {t:'level', rms, floor, speaking}  {t:'calibrated', floor}
 * Messages IN:   {t:'calibrate', ms} {t:'config', ratio?, absMin?}
 */
class AudioGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(320);          // 20 ms @ 16 kHz
    this.fill = 0;
    this.floor = 0.004;                          // noise floor (RMS), adapts slowly
    this.ratio = 3.2;                            // speech if rms > floor * ratio (~10 dB)
    this.absMin = 0.012;                         // ...and above this absolute level
    this.speaking = false;
    this.hang = 0; this.hangFrames = 20;         // 400 ms hangover bridges short pauses
    this.onFrames = 0;                           // consecutive loud frames (debounce)
    this.preroll = [];                           // last 300 ms before speech onset
    this.speechFrames = 0;
    this.cal = null; this.levelTick = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'calibrate') this.cal = { left: Math.ceil(m.ms / 20), vals: [] };
      if (m.t === 'config') { if (m.ratio) this.ratio = m.ratio; if (m.absMin) this.absMin = m.absMin; }
    };
  }

  rms(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / f.length); }

  handle(frame) {
    const r = this.rms(frame);

    if (this.cal) {                               // calibration: measure ambient noise
      this.cal.vals.push(r);
      if (--this.cal.left <= 0) {
        const v = this.cal.vals.sort((a, b) => a - b);
        this.floor = Math.max(0.002, v[Math.floor(v.length * 0.9)]);   // p90 of ambient
        this.absMin = Math.max(0.012, this.floor * 2.5);
        this.port.postMessage({ t: 'calibrated', floor: this.floor, absMin: this.absMin });
        this.cal = null;
      }
      return;
    }

    const loud = r > Math.max(this.floor * this.ratio, this.absMin);
    if (!this.speaking) {
      this.floor = 0.97 * this.floor + 0.03 * r;  // track ambient only when not speaking
      this.preroll.push(frame.slice()); if (this.preroll.length > 15) this.preroll.shift();
      this.onFrames = loud ? this.onFrames + 1 : 0;
      if (this.onFrames >= 3) {                   // 60 ms of sustained energy = speech onset
        this.speaking = true; this.hang = this.hangFrames; this.speechFrames = 0;
        this.port.postMessage({ t: 'start' });
        for (const p of this.preroll) this.post(p);
        this.preroll = [];
      }
    } else {
      this.post(frame.slice());
      this.hang = loud ? this.hangFrames : this.hang - 1;
      if (this.hang <= 0) {
        this.speaking = false; this.onFrames = 0;
        this.port.postMessage({ t: 'end', ms: this.speechFrames * 20 });
      }
    }
    if (++this.levelTick % 5 === 0) this.port.postMessage({ t: 'level', rms: r, floor: this.floor, speaking: this.speaking });
  }

  post(f) { this.speechFrames++; this.port.postMessage({ t: 'audio', buf: f }, [f.buffer]); }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.frame[this.fill++] = ch[i];
      if (this.fill === this.frame.length) { this.handle(this.frame); this.fill = 0; }
    }
    return true;
  }
}
registerProcessor('audio-gate', AudioGate);
