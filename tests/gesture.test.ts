import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GestureEngine, type GestureEvent } from '../src/gesture/GestureEngine';
import { makeHand, type HandSpec } from './handFactory';

const FPS = 30, DT = 1000 / FPS;

function rig() {
  const ev: GestureEvent[] = [];
  const eng = new GestureEngine(e => ev.push(e));
  let t = 1000;
  // NOTE: camera is un-mirrored; engine mirrors. Moving hand to user's LEFT = x increasing in raw frame.
  const frame = (s: HandSpec | null) => { eng.process(s ? makeHand(s) : null, t); t += DT; };
  const hold = (s: HandSpec, ms: number) => { for (let i = 0; i < ms / DT; i++) frame(s); };
  const of = (type: GestureEvent['type']) => ev.filter(e => e.type === type);
  const engage = (cx = 0.5, cy = 0.45) => hold({ cx, cy }, 700);
  return { eng, ev, frame, hold, of, engage, now: () => t };
}

test('open palm arms after hold and engages', () => {
  const r = rig(); r.engage();
  assert.ok(r.of('state').some(e => (e as any).state === 'engaged'));
});

test('FP: quick hello-wave (shorter than arm time) produces nothing', () => {
  const r = rig();
  for (let x = 0.2; x < 0.8; x += 0.05) r.frame({ cx: x, cy: 0.4 });        // ~12 frames = 400 ms
  const actions = r.ev.filter(e => ['swipe', 'tap', 'scroll', 'zoom'].includes(e.type));
  assert.equal(actions.length, 0, 'actions must not fire before engagement');
});

test('FP: fist / pointing hand never arms', () => {
  const r = rig();
  r.hold({ cx: 0.5, cy: 0.45, index: false, middle: false, ring: false, pinky: false, thumbOut: false }, 1500);
  r.hold({ cx: 0.5, cy: 0.45, index: true, middle: false, ring: false, pinky: false, thumbOut: false }, 1500);
  assert.equal(r.of('state').length, 0);
});

test('FP: sensor jitter on an engaged resting hand emits no actions', () => {
  const r = rig(); r.engage(); r.ev.length = 0;
  for (let i = 0; i < 90; i++) r.frame({ cx: 0.5 + (Math.random() - 0.5) * 0.006, cy: 0.45 + (Math.random() - 0.5) * 0.006 });
  assert.equal(r.ev.filter(e => e.type !== 'cursor').length, 0);
});

test('swipe left (user perspective) -> raw x increases', () => {
  const r = rig(); r.engage(0.3); r.ev.length = 0;
  for (let i = 0; i <= 9; i++) r.frame({ cx: 0.3 + i * 0.05, cy: 0.45 });   // ~0.45 in 300ms (filter adds ~2 frames lag)
  const sw = r.of('swipe');
  assert.equal(sw.length, 1);
  assert.equal((sw[0] as any).dir, 'left');
});

test('swipe right and return stroke suppressed', () => {
  const r = rig(); r.engage(0.7); r.ev.length = 0;
  for (let i = 0; i <= 9; i++) r.frame({ cx: 0.7 - i * 0.05, cy: 0.45 });   // right
  for (let i = 0; i <= 12; i++) r.frame({ cx: 0.25 + i * 0.03, cy: 0.45 }); // natural return stroke
  const sw = r.of('swipe').map(e => (e as any).dir);
  assert.deepEqual(sw, ['right']);
});

test('slow horizontal drift is not a swipe', () => {
  const r = rig(); r.engage(0.3); r.ev.length = 0;
  for (let i = 0; i < 60; i++) r.frame({ cx: 0.3 + i * 0.006, cy: 0.45 });
  assert.equal(r.of('swipe').length, 0);
});

test('scroll: dead zone then joystick, direction by vertical offset', () => {
  const r = rig(); r.engage(0.5, 0.45); r.ev.length = 0;
  r.hold({ cx: 0.5, cy: 0.47 }, 600);                    // inside dead zone
  assert.equal(r.of('scroll').length, 0);
  r.hold({ cx: 0.5, cy: 0.30 }, 600);                    // hand up
  const up = r.of('scroll') as any[];
  assert.ok(up.length > 0 && up.every(e => e.dy < 0), 'hand up => negative dy');
  r.ev.length = 0; r.hold({ cx: 0.5, cy: 0.62 }, 900);   // hand down past anchor
  assert.ok((r.of('scroll') as any[]).some(e => e.dy > 0));
});

test('tap: quick pinch-release fires once; long pinch does not', () => {
  const r = rig(); r.engage(); r.ev.length = 0;
  r.hold({ cx: 0.5, cy: 0.45, pinch: 0.005 }, 200);
  r.hold({ cx: 0.5, cy: 0.45 }, 300);
  assert.equal(r.of('tap').length, 1);
  r.ev.length = 0;
  r.hold({ cx: 0.5, cy: 0.45, pinch: 0.005 }, 800);      // hold = not a tap
  r.hold({ cx: 0.5, cy: 0.45 }, 300);
  assert.equal(r.of('tap').length, 0);
});

test('zoom: widening thumb-index spread emits delta > 1', () => {
  const r = rig(); r.engage(); r.ev.length = 0;
  const z = (spread: number) => ({ cx: 0.5, cy: 0.45, index: true, middle: false, ring: false, pinky: false, thumbOut: true, spread });
  r.hold(z(0.10), 300);
  for (let s = 0.10; s <= 0.20; s += 0.005) r.frame(z(s));
  const zs = r.of('zoom') as any[];
  assert.ok(zs.length > 3 && zs.every(e => e.delta > 1));
});

test('fist disengages; lost hand disengages after timeout', () => {
  const r = rig(); r.engage(); r.ev.length = 0;
  r.hold({ cx: 0.5, cy: 0.45, index: false, middle: false, ring: false, pinky: false, thumbOut: false }, 600);
  assert.ok(r.of('state').some(e => (e as any).state === 'idle'));
  const r2 = rig(); r2.engage(); r2.ev.length = 0;
  for (let i = 0; i < 50; i++) r2.frame(null);
  assert.ok(r2.of('state').some(e => (e as any).state === 'idle'));
});

test('calibration derives personal pinch thresholds', () => {
  const r = rig();
  r.eng.collect('open');   r.hold({ cx: 0.5, cy: 0.45 }, 500);
  r.eng.collect('closed'); r.hold({ cx: 0.5, cy: 0.45, pinch: 0.01 }, 500);
  const p = r.eng.finishCalibration();
  assert.ok(p && p.pinchOn! < p.pinchOff!);
});


test('thumb up + index pointing LEFT = go back (swipe right/previous); pointing RIGHT = forward', () => {
  // Landmarks in the USER's (mirrored) view, then un-mirrored for the raw camera frame.
  const pose = (dirSign: number) => {
    const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.65 }));
    const wx = 0.5 - dirSign * 0.1;
    lm[0] = { x: wx, y: 0.72 }; lm[5] = { x: 0.5, y: 0.62 }; lm[9] = { x: 0.52 - dirSign * 0.02, y: 0.64 };
    lm[6] = { x: 0.5 + dirSign * 0.06, y: 0.62 }; lm[8] = { x: 0.5 + dirSign * 0.15, y: 0.62 };
    [10, 11, 12, 14, 15, 16, 18, 19, 20].forEach(i => (lm[i] = { x: wx + dirSign * 0.03, y: 0.7 }));
    lm[10] = { x: 0.5 - dirSign * 0.02, y: 0.66 }; lm[14] = { x: 0.5 - dirSign * 0.03, y: 0.68 }; lm[18] = { x: 0.5 - dirSign * 0.04, y: 0.69 };
    lm[2] = { x: 0.5 - dirSign * 0.04, y: 0.66 }; lm[3] = { x: 0.5 - dirSign * 0.04, y: 0.6 }; lm[4] = { x: 0.5 - dirSign * 0.04, y: 0.52 };
    return lm.map(p => ({ x: 1 - p.x, y: p.y }));
  };
  for (const [sign, expected] of [[-1, 'right'], [1, 'left']] as const) {
    const r = rig(); r.engage();
    for (let i = 0; i < 20; i++) r.eng.process(pose(sign), r.now() + i * DT);
    const sw = r.of('swipe').map(e => (e as any).dir);
    assert.deepEqual(sw, [expected]);
  }
});
