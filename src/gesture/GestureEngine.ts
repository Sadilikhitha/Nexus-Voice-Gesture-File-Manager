/**
 * GestureEngine — pure, deterministic landmarks -> intent state machine.
 *
 * No DOM, no MediaPipe, no timers: it consumes (landmarks, timestamp) and calls
 * `emit`. That makes it runnable inside a Web Worker AND unit-testable in Node.
 *
 * FALSE-POSITIVE STRATEGY & RESPONSIVE GESTURE RECOGNITION:
 *   1. ENGAGEMENT GATE – user shows an open palm to engage. Fist disengages.
 *   2. SCALE-NORMALISED GEOMETRY – distances divided by palm size for rotation
 *      and camera-distance invariance.
 *   3. FAST PINCH & RELEASE – instant tap detection supporting fast micro-pinches
 *      without laggy smoothing or over-constraining palm movement.
 *   4. 4-WAY RESPONSIVE SWIPES – right-to-left (next), left-to-right (previous),
 *      swipe-up (scroll up), and swipe-down (scroll down).
 *   5. TWO-FINGER ZOOM – pinch closer to zoom out, spread apart to zoom in.
 *   6. OPEN PALM PAUSE – holding an open palm while engaged pauses/resumes recognition.
 */
import { OneEuroFilter } from './OneEuroFilter';

export interface LM { x: number; y: number; z?: number }

export interface GestureConfig {
  armMs: number;            // open palm hold time before engagement
  disengageMs: number;      // hand lost this long -> idle
  fistReleaseMs: number;    // fist hold time -> disengage
  pauseMs: number;          // open palm hold to toggle pause
  poseFrames: number;       // frames a pose must persist
  extendRatio: number;      // tip/pip distance-from-wrist ratio to call a finger "extended"
  thumbOutRatio: number;    // thumbTip->pinkyMCP / palmSize to call the thumb "out"
  pinchOn: number;          // thumb-index / palmSize below which pinch starts
  pinchOff: number;         // ...above which it ends (hysteresis)
  tapMaxMs: number;
  tapMaxTravel: number;     // palm travel allowed during a tap
  tapCooldownMs: number;
  scrollDead: number;       // vertical offset around anchor
  scrollGain: number;       // px/s per unit of offset beyond dead zone
  swipeMinDx: number;       // horizontal swipe min distance
  swipeMinDy: number;       // vertical swipe min distance
  swipeMinSpeed: number;    // speed in frame fraction / s
  swipeWindowMs: number;
  swipeCooldownMs: number;
  zoomDead: number;         // relative spread change before zoom engages
  minPalmSize: number;      // reject hands smaller than this
  filterMinCutoff: number;  // One-Euro smoothing at rest
  filterBeta: number;
  activeBox: { x0: number; x1: number; y0: number; y1: number };
}

export const DEFAULT_GESTURE_CONFIG: GestureConfig = {
  armMs: 380, disengageMs: 1200, fistReleaseMs: 300, pauseMs: 3200, poseFrames: 2,
  extendRatio: 1.10, thumbOutRatio: 1.0, pinchOn: 0.32, pinchOff: 0.44,
  tapMaxMs: 450, tapMaxTravel: 0.12, tapCooldownMs: 250,
  scrollDead: 0.05, scrollGain: 3200,
  swipeMinDx: 0.12, swipeMinDy: 0.12, swipeMinSpeed: 0.75, swipeWindowMs: 420, swipeCooldownMs: 450,
  zoomDead: 0.02, minPalmSize: 0.04,
  filterMinCutoff: 1.0, filterBeta: 4,
  activeBox: { x0: 0.12, x1: 0.88, y0: 0.10, y1: 0.78 },
};

export type GestureEvent =
  | { type: 'state'; state: 'idle' | 'arming' | 'engaged' | 'paused' }
  | { type: 'cursor'; x: number; y: number; visible: boolean; pinching: boolean }
  | { type: 'scroll'; dy: number }
  | { type: 'zoom'; delta: number }
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; dir: 'left' | 'right' | 'up' | 'down' }
  | { type: 'debug'; text: string }
  | { type: 'nav'; dir: 'back' | 'forward' };

type Pose = 'NONE' | 'PALM' | 'ZOOM' | 'FIST' | 'OTHER';
const d2 = (a: LM, b: LM) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const median = (a: number[]) => { const s = [...a].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };

export class GestureEngine {
  cfg: GestureConfig;
  private emit: (e: GestureEvent) => void;

  private state: 'idle' | 'arming' | 'engaged' | 'paused' = 'idle';
  private armStart: number | null = null;
  private pauseStart: number | null = null;
  private lastSeen = 0;

  private fx: OneEuroFilter; private fy: OneEuroFilter;
  private pinchEma: number | null = null;
  private spreadEma: number | null = null;

  private rawPose: Pose = 'NONE'; private rawCount = 0; private pose: Pose = 'NONE';
  private fistStart: number | null = null;

  private pinching = false; private pinchStartT = 0;
  private pinchStartPos = { x: 0, y: 0 }; private tapLockUntil = 0;

  private anchorY = 0; private scrollLockUntil = 0;
  private hist: { t: number; x: number; y: number }[] = [];
  private swipeLockUntil = 0; private lastSwipe: { dir: 'left' | 'right' | 'up' | 'down'; t: number } | null = null;

  // thumb-up + index-pointing gesture (go back / go forward)
  private lastDbg = 0;
  private pointDir: 'left' | 'right' | null = null; private pointSince = 0; private pointArmed = true; private pointLockUntil = 0;

  private zoomBase = 0; private zoomLast = 0; private zoomActive = false;
  private lastT = 0;

  // calibration
  private calKind: 'open' | 'closed' | null = null;
  private cal = { open: [] as number[], closed: [] as number[] };

  constructor(emit: (e: GestureEvent) => void, cfg: Partial<GestureConfig> = {}) {
    this.cfg = { ...DEFAULT_GESTURE_CONFIG, ...cfg };
    this.emit = emit;
    this.fx = new OneEuroFilter(this.cfg.filterMinCutoff, this.cfg.filterBeta);
    this.fy = new OneEuroFilter(this.cfg.filterMinCutoff, this.cfg.filterBeta);
  }

  setConfig(patch: Partial<GestureConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    for (const f of [this.fx, this.fy]) { f.minCutoff = this.cfg.filterMinCutoff; f.beta = this.cfg.filterBeta; }
  }

  // ---------------------------------------------------------------- calibration
  collect(kind: 'open' | 'closed' | null): void { this.calKind = kind; if (kind) this.cal[kind] = []; }

  finishCalibration(): Partial<GestureConfig> | null {
    const open = median(this.cal.open), closed = median(this.cal.closed);
    this.calKind = null;
    if (!(open > closed + 0.20) || this.cal.open.length < 8 || this.cal.closed.length < 8) return null;
    const patch = { pinchOn: closed + 0.32 * (open - closed), pinchOff: closed + 0.58 * (open - closed) };
    this.setConfig(patch);
    return patch;
  }

  // ------------------------------------------------------------------- frame in
  process(lm: LM[] | null, tMs: number): void {
    const dt = this.lastT ? Math.max(0.001, (tMs - this.lastT) / 1000) : 1 / 30;
    this.lastT = tMs;
    if (!lm || lm.length < 21) return this.handLost(tMs);

    // mirror x so on-screen motion matches user perspective
    const P = lm.map(p => ({ x: 1 - p.x, y: p.y }));
    const palmSize = d2(P[0], P[9]);
    if (palmSize < this.cfg.minPalmSize) return this.handLost(tMs);
    this.lastSeen = tMs;

    // Centroid of palm
    const cx = (P[0].x + P[5].x + P[9].x + P[13].x + P[17].x) / 5;
    const cy = (P[0].y + P[5].y + P[9].y + P[13].y + P[17].y) / 5;
    const tS = tMs / 1000;
    const px = this.fx.filter(cx, tS), py = this.fy.filter(cy, tS);

    // ---- finger geometry
    const ext = (tip: number, pip: number) => d2(P[tip], P[0]) > d2(P[pip], P[0]) * this.cfg.extendRatio;
    const index = ext(8, 6), middle = ext(12, 10), ring = ext(16, 14), pinky = ext(20, 18);
    const thumbOut = d2(P[4], P[17]) / palmSize > this.cfg.thumbOutRatio;
    const pinchRaw = d2(P[4], P[8]) / palmSize;

    // responsive pinch smoothing with fast attack
    this.pinchEma = this.pinchEma === null ? pinchRaw : 0.75 * pinchRaw + 0.25 * this.pinchEma;
    this.spreadEma = this.spreadEma === null ? pinchRaw : 0.45 * pinchRaw + 0.55 * this.spreadEma;

    let raw: Pose;
    if (!index && !middle && !ring && !pinky) raw = 'FIST';
    else if (index && thumbOut && !middle && !ring && !pinky) raw = 'ZOOM';
    else if (middle && ring && pinky) raw = 'PALM';
    else raw = 'OTHER';

    if (raw === this.rawPose) this.rawCount++; else { this.rawPose = raw; this.rawCount = 1; }
    const prevPose = this.pose;
    if (this.rawCount >= this.cfg.poseFrames) this.pose = raw;
    const poseChanged = this.pose !== prevPose;

    // calibration sampling
    if (this.calKind && this.pose !== 'FIST') this.cal[this.calKind].push(pinchRaw);

    // ---- engagement state machine
    if (this.state === 'idle' || this.state === 'arming') {
      if (this.pose === 'PALM' && pinchRaw > this.cfg.pinchOff) {
        if (this.armStart === null) { this.armStart = tMs; this.setState('arming'); }
        if (tMs - this.armStart >= this.cfg.armMs) {
          this.setState('engaged');
          this.resetPalmTracking(py, tMs);
        }
      } else if (this.armStart !== null) {
        this.armStart = null;
        this.setState('idle');
      }
      return;
    }

    // Explicit release with a fist anytime
    if (this.pose === 'FIST') {
      this.fistStart ??= tMs;
      if (tMs - this.fistStart >= this.cfg.fistReleaseMs) return this.disengage();
    } else {
      this.fistStart = null;
    }

    // Open palm pause / resume toggle
    const isFlatOpenPalm = index && middle && ring && pinky && thumbOut && pinchRaw > 0.55;
    if (isFlatOpenPalm) {
      this.pauseStart ??= tMs;
      if (tMs - this.pauseStart >= this.cfg.pauseMs) {
        this.pauseStart = tMs + 800; // prevent rapid re-toggle
        if (this.state === 'engaged') {
          this.setState('paused');
          this.emit({ type: 'cursor', x: 0, y: 0, visible: false, pinching: false });
          return;
        } else if (this.state === 'paused') {
          this.setState('engaged');
          this.resetPalmTracking(py, tMs);
          return;
        }
      }
    } else {
      this.pauseStart = null;
    }

    if (this.state === 'paused') {
      return; // Gestures are paused: cursor hidden, actions suppressed
    }

    // ---- THUMB UP + INDEX POINTING: index toward the user's LEFT = go back, toward the RIGHT = go forward.
    // Other three fingers curled. Hold ~0.3 s; then drop/relax the hand to re-arm. (x is already mirrored.)
    {
      const ix = P[8].x - P[5].x, iy = P[8].y - P[5].y, ilen = Math.hypot(ix, iy) || 1;
      const thumbRise = P[2].y - P[4].y;                                   // > 0 when the thumb tip is above its base
      const thumbUp = thumbRise > 0.25 * palmSize && Math.abs(P[4].x - P[2].x) < 1.3 * thumbRise;
      const pointing = index && !middle && !ring && !pinky && ilen > 0.3 * palmSize && Math.abs(iy) < 0.85 * Math.abs(ix);
      const dir: 'left' | 'right' | null = thumbUp && pointing ? (ix < 0 ? 'left' : 'right') : null;
      if (tMs - this.lastDbg > 150) {
        this.lastDbg = tMs;
        this.emit({ type: 'debug', text: `${this.state} · fingers ${index ? 'I' : '-'}${middle ? 'M' : '-'}${ring ? 'R' : '-'}${pinky ? 'P' : '-'} · thumbUp ${thumbUp ? 'YES' : 'no'} (${(thumbRise / palmSize).toFixed(2)}) · index→ ${pointing ? (ix < 0 ? 'LEFT' : 'RIGHT') : 'no'}` });
      }
      if (dir) {
        if (dir !== this.pointDir) { this.pointDir = dir; this.pointSince = tMs; }
        if (this.pointArmed && tMs - this.pointSince >= 300 && tMs >= this.pointLockUntil) {
          this.pointArmed = false; this.pointLockUntil = tMs + 900;
          this.emit({ type: 'nav', dir: dir === 'left' ? 'back' : 'forward' });
        }
        this.pinching = false; this.zoomActive = false; this.hist = [];
        return; // while this pose is held, no cursor / tap / zoom / scroll
      }
      this.pointDir = null; this.pointArmed = true;
    }

    const box = this.cfg.activeBox;
    const sx = clamp01((px - box.x0) / (box.x1 - box.x0));
    const sy = clamp01((py - box.y0) / (box.y1 - box.y0));

    // ---- fast pinch & tap detection
    const wasPinching = this.pinching;
    const isPinchNow = (pinchRaw < this.cfg.pinchOn) || (this.pinchEma !== null && this.pinchEma < this.cfg.pinchOn);
    const isReleaseNow = (pinchRaw > this.cfg.pinchOff);

    if (this.pose === 'PALM' || this.pose === 'OTHER') {
      if (!this.pinching && isPinchNow) {
        this.pinching = true;
        this.pinchStartT = tMs;
        this.pinchStartPos = { x: px, y: py };
      } else if (this.pinching && isReleaseNow) {
        this.pinching = false;
        const dur = tMs - this.pinchStartT;
        const travel = Math.hypot(px - this.pinchStartPos.x, py - this.pinchStartPos.y);
        if (dur <= this.cfg.tapMaxMs && travel <= this.cfg.tapMaxTravel && tMs >= this.tapLockUntil) {
          const tx = clamp01((this.pinchStartPos.x - box.x0) / (box.x1 - box.x0));
          const ty = clamp01((this.pinchStartPos.y - box.y0) / (box.y1 - box.y0));
          this.tapLockUntil = tMs + this.cfg.tapCooldownMs;
          this.emit({ type: 'tap', x: tx, y: ty });
        }
      }
    } else {
      this.pinching = false;
    }

    this.emit({ type: 'cursor', x: sx, y: sy, visible: true, pinching: this.pinching });

    if (poseChanged && this.pose === 'PALM') this.resetPalmTracking(py, tMs);

    // ---- Swipes and joystick scroll
    if (this.pose === 'PALM' && !this.pinching) {
      this.pushHistory(tMs, px, py);
      const swiped = this.detectSwipe(tMs);
      if (!swiped) this.joystickScroll(py, dt, tMs);
    }

    // ---- ZOOM: two-finger spread/pinch
    if (this.pose === 'ZOOM') {
      if (poseChanged) {
        this.spreadEma = pinchRaw;
        this.zoomBase = this.zoomLast = pinchRaw;
        this.zoomActive = false;
      }
      const spread = this.spreadEma!;
      if (!this.zoomActive && Math.abs(spread / this.zoomBase - 1) > this.cfg.zoomDead) this.zoomActive = true;
      if (this.zoomActive && this.zoomLast > 0) {
        const delta = spread / this.zoomLast;
        if (Math.abs(delta - 1) > 0.002) this.emit({ type: 'zoom', delta });
        this.zoomLast = spread;
      }
    } else {
      this.zoomActive = false;
    }
  }

  // -------------------------------------------------------------------- helpers
  private joystickScroll(py: number, dt: number, tMs: number): void {
    if (tMs < this.scrollLockUntil) return;
    if (this.hist.length >= 2) {
      const a = this.hist[0], b = this.hist[this.hist.length - 1];
      const sp = Math.abs(b.x - a.x) / Math.max(0.001, (b.t - a.t) / 1000);
      if (sp > 0.6) return;
    }
    const off = py - this.anchorY;
    const mag = Math.abs(off) - this.cfg.scrollDead;
    if (mag <= 0) return;
    this.emit({ type: 'scroll', dy: Math.sign(off) * mag * this.cfg.scrollGain * dt });
  }

  private detectSwipe(tMs: number): boolean {
    if (tMs < this.swipeLockUntil || this.hist.length < 3) return false;
    const last = this.hist[this.hist.length - 1];
    const prev = this.hist[this.hist.length - 2];
    const first = this.hist.find(h => tMs - h.t <= this.cfg.swipeWindowMs) || this.hist[0];
    const secs = Math.max(0.04, (last.t - first.t) / 1000);
    const dx = last.x - first.x, dy = last.y - first.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Instant velocity check: a swipe must be actively in motion at the end, not stationary
    const recentSecs = Math.max(0.015, (last.t - prev.t) / 1000);
    const recentSpeedX = Math.abs(last.x - prev.x) / recentSecs;
    const recentSpeedY = Math.abs(last.y - prev.y) / recentSecs;

    // Horizontal swipe check: user's right-to-left is dx < 0; left-to-right is dx > 0
    if (absDx >= this.cfg.swipeMinDx && absDx >= absDy * 0.75 && recentSpeedX > 0.35) {
      const speed = absDx / secs;
      const dir: 'left' | 'right' = dx < 0 ? 'left' : 'right';
      let need = this.cfg.swipeMinSpeed;
      if (this.lastSwipe && this.lastSwipe.dir !== dir && tMs - this.lastSwipe.t < 600) need *= 1.3;
      if (speed >= need) {
        this.swipeLockUntil = tMs + this.cfg.swipeCooldownMs;
        this.lastSwipe = { dir, t: tMs };
        this.hist = [];
        this.anchorY = last.y;
        this.scrollLockUntil = tMs + 400;
        this.emit({ type: 'swipe', dir });
        return true;
      }
    }

    // Vertical swipe check: swipe up is dy < 0; swipe down is dy > 0
    if (absDy >= this.cfg.swipeMinDy && absDy >= absDx * 0.75 && recentSpeedY > 0.25) {
      const speed = absDy / secs;
      const dir: 'up' | 'down' = dy < 0 ? 'up' : 'down';
      let need = this.cfg.swipeMinSpeed;
      if (speed >= need) {
        this.swipeLockUntil = tMs + this.cfg.swipeCooldownMs;
        this.lastSwipe = { dir, t: tMs };
        this.hist = [];
        this.anchorY = last.y;
        this.scrollLockUntil = tMs + 400;
        this.emit({ type: 'swipe', dir });
        return true;
      }
    }

    return false;
  }

  private pushHistory(t: number, x: number, y: number): void {
    this.hist.push({ t, x, y });
    while (this.hist.length && t - this.hist[0].t > 450) this.hist.shift();
  }

  private resetPalmTracking(py: number, tMs: number): void {
    this.anchorY = py; this.hist = []; this.scrollLockUntil = tMs + 250;
  }

  private setState(s: 'idle' | 'arming' | 'engaged' | 'paused'): void {
    if (s !== this.state) { this.state = s; this.emit({ type: 'state', state: s }); }
  }

  disengage(): void {
    this.armStart = null; this.fistStart = null; this.pauseStart = null; this.pinching = false; this.zoomActive = false;
    this.hist = [];
    this.emit({ type: 'cursor', x: 0, y: 0, visible: false, pinching: false });
    this.setState('idle');
  }

  private handLost(tMs: number): void {
    this.pinching = false; this.rawPose = 'NONE'; this.rawCount = 0; this.pose = 'NONE';
    this.pinchEma = null; this.spreadEma = null; this.hist = [];
    this.fx.reset(); this.fy.reset();
    if (this.state === 'arming') { this.armStart = null; this.setState('idle'); }
    if (this.state === 'engaged' || this.state === 'paused') {
      this.emit({ type: 'cursor', x: 0, y: 0, visible: false, pinching: false });
      if (tMs - this.lastSeen >= this.cfg.disengageMs) this.disengage();
    }
  }
}