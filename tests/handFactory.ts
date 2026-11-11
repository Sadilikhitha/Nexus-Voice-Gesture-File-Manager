/** Synthetic MediaPipe-style hand (un-mirrored, upright, fingers toward y=0). */
import type { LM } from '../src/gesture/GestureEngine';

export interface HandSpec {
  cx: number; cy: number;
  index?: boolean; middle?: boolean; ring?: boolean; pinky?: boolean;
  thumbOut?: boolean;
  pinch?: number;      // 0 = tips touching; omitted = not pinching
  spread?: number;     // thumb-index tip gap in frame units for ZOOM pose
}

export function makeHand(s: HandSpec): LM[] {
  const { cx, cy } = s;
  const lm: LM[] = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
  lm[0] = { x: cx, y: cy + 0.12 };
  const mcp = [ { x: cx - 0.04, y: cy }, { x: cx - 0.012, y: cy - 0.005 }, { x: cx + 0.015, y: cy }, { x: cx + 0.04, y: cy + 0.01 } ];
  const flags = [s.index ?? true, s.middle ?? true, s.ring ?? true, s.pinky ?? true];
  [5, 9, 13, 17].forEach((base, i) => {
    const m = mcp[i]; lm[base] = m;
    lm[base + 1] = { x: m.x, y: m.y - 0.035 };                  // PIP
    lm[base + 2] = { x: m.x, y: m.y - (flags[i] ? 0.06 : 0.02) };
    lm[base + 3] = { x: m.x, y: m.y - (flags[i] ? 0.09 : -0.01) }; // TIP
  });
  lm[1] = { x: cx - 0.05, y: cy + 0.1 }; lm[2] = { x: cx - 0.075, y: cy + 0.07 }; lm[3] = { x: cx - 0.1, y: cy + 0.04 };
  lm[4] = s.thumbOut ?? true ? { x: cx - 0.13, y: cy + 0.02 } : { x: cx - 0.02, y: cy + 0.03 };
  if (s.pinch !== undefined) {                                   // thumb meets index tip
    const tip = { x: cx - 0.07, y: cy - 0.03 };
    lm[8] = { x: tip.x - s.pinch / 2, y: tip.y }; lm[4] = { x: tip.x + s.pinch / 2, y: tip.y };
  }
  if (s.spread !== undefined) {                                   // ZOOM pose: thumb out, spread controls gap
    lm[4] = { x: lm[8].x - s.spread, y: lm[8].y + 0.01 };
    lm[8].y = cy - 0.09;
  }
  return lm;
}
