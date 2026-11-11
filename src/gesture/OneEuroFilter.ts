/**
 * One-Euro filter (Casiez et al., CHI 2012).
 * Adaptive low-pass: heavy smoothing when the hand is slow (kills jitter),
 * light smoothing when it is fast (keeps latency low). Ideal for hand cursors.
 */
class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null { return this.y; }
  reset(): void { this.y = null; }
}

export class OneEuroFilter {
  private xf = new LowPass();
  private dxf = new LowPass();
  private tPrev: number | null = null;

  /**
   * @param minCutoff Hz; lower = smoother at rest (try 0.8-1.5)
   * @param beta      speed coefficient; higher = less lag when moving fast.
   *                  Scale with your units: for 0..1 frame coords (speeds ~1/s) use ~2-8.
   * @param dCutoff   Hz; cutoff for the derivative estimate
   */
  constructor(public minCutoff = 1.0, public beta = 4, public dCutoff = 1.0) {}

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param tSec monotonically increasing timestamp in SECONDS */
  filter(x: number, tSec: number): number {
    if (this.tPrev === null) {
      this.tPrev = tSec;
      this.dxf.filter(0, 1);
      return this.xf.filter(x, 1);
    }
    const dt = Math.max(1e-3, tSec - this.tPrev);
    this.tPrev = tSec;
    const prev = this.xf.last() ?? x;
    const dx = (x - prev) / dt;
    const edx = this.dxf.filter(dx, OneEuroFilter.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xf.filter(x, OneEuroFilter.alpha(cutoff, dt));
  }

  reset(): void { this.xf.reset(); this.dxf.reset(); this.tPrev = null; }
}
