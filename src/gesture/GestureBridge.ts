/**
 * GestureBridge (main thread): camera -> worker -> DOM events.
 * Main-thread cost per frame ~ one createImageBitmap + postMessage (< 1 ms),
 * so the UI keeps its 60 FPS. Frames are dropped (never queued) if the worker is busy.
 */
import { emit } from '../shared/bus';
import type { GestureConfig, GestureEvent } from './GestureEngine';

export class GestureBridge {
  private video = document.createElement('video');
  private worker?: Worker;
  private stream?: MediaStream;
  private busy = false; private ready = false; private running = false;
  private firstFrame = false; private pumpToken = 0;
  private opts?: { wasmPath: string; modelPath: string; config?: Partial<GestureConfig> };
  /** GPU is faster, but hangs on some machines; after one stall we switch to CPU and remember it. */
  private delegate: 'GPU' | 'CPU' = (() => { try { return localStorage.getItem('nexus.delegate') === 'CPU' ? 'CPU' : 'GPU'; } catch { return 'GPU' as const; } })();
  private lastFrameAt = 0; private watchdog?: number; private initError = ''; private stage = 'not started';
  private step(s: string) { this.stage = s; console.log('[gesture] step:', s); }
  private calResolve?: (p: Partial<GestureConfig> | null) => void;
  private scratch = document.createElement('canvas');

  async start(opts: { wasmPath: string; modelPath: string; config?: Partial<GestureConfig> }): Promise<void> {
    try {
      this.step('1/4 asking the browser for camera access');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: { ideal: 30 }, facingMode: 'user' }, audio: false,
      });
      this.step('2/4 starting the video');
      Object.assign(this.video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
      document.body.appendChild(this.video);
      this.video.srcObject = this.stream; this.video.muted = true; this.video.playsInline = true;
      await this.video.play();

      this.opts = opts; this.running = true;
      this.spawnWorker();
      this.pump();
      // Watchdog. Generous limits: browsers pause video callbacks while the tab is hidden, and the first
      // inference can be slow. A real stall on GPU triggers ONE automatic restart on CPU before giving up.
      this.watchdog = window.setInterval(() => {
        if (!this.running) return;
        if (document.hidden) { this.lastFrameAt = performance.now(); return; }
        const limit = !this.ready ? 30000 : !this.firstFrame ? 10000 : 6000;
        if (performance.now() - this.lastFrameAt <= limit) return;
        if (this.delegate === 'GPU') {
          console.warn('[gesture] GPU stalled -> restarting on CPU');
          this.delegate = 'CPU'; try { localStorage.setItem('nexus.delegate', 'CPU'); } catch { /* ignore */ }
          this.spawnWorker(); return;
        }
        const v = this.video, tr = this.stream?.getVideoTracks()[0];
        this.fail(!this.ready ? (this.initError || 'hand model did not load within 30 s')
          : `camera stalled (busy=${this.busy}, video readyState=${v.readyState}, paused=${v.paused}, track=${tr?.readyState}, firstFrameDone=${this.firstFrame}, delegate=${this.delegate})`);
      }, 1000);
    } catch (err) { const e = err as Error; this.fail(`${e?.name ?? 'Error'}: ${e?.message || 'no details'}`); }
  }

  /** (Re)create the worker and load the model with the current delegate. */
  private spawnWorker(): void {
    this.step(`3/4 starting the gesture worker (${this.delegate})`);
    this.worker?.terminate();
    this.worker = new Worker(new URL('./gesture.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.onWorker(e.data);
    this.worker.onerror = (e) => { console.error('[gesture worker crashed]', e); this.fail(e.message || 'worker failed to start (see console)'); };
    this.ready = false; this.busy = false; this.firstFrame = false; this.lastFrameAt = performance.now();
    this.step(`4/4 loading hand model + WASM on ${this.delegate} (can take several seconds)`);
    this.worker.postMessage({ t: 'init', ...this.opts, delegate: this.delegate });
  }

  stop(): void {
    this.running = false; clearInterval(this.watchdog);
    this.stream?.getTracks().forEach(t => t.stop()); this.worker?.terminate();
    this.worker = undefined; this.stream = undefined; this.ready = false; this.firstFrame = false;
    this.video.remove();
  }

  setConfig(config: Partial<GestureConfig>): void { this.worker?.postMessage({ t: 'config', config }); }

  /**
   * Calibration: (1) lighting check, (2) personal pinch thresholds.
   * `prompt` lets the UI tell the user what to do at each step.
   */
  async calibrate(prompt: (step: 'lighting' | 'open' | 'pinch' | 'done', info?: string) => void): Promise<void> {
    prompt('lighting');
    const lum = await this.measureLuminance(1000);
    if (lum < 70) { // dim room: relax detection, smooth more
      this.worker?.postMessage({ t: 'detection', conf: 0.45 });
      this.setConfig({ filterMinCutoff: 0.8 });
      prompt('lighting', `Low light detected (${Math.round(lum)}/255) — sensitivity raised`);
    } else this.worker?.postMessage({ t: 'detection', conf: 0.6 });

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    prompt('open'); this.worker?.postMessage({ t: 'collect', kind: 'open' }); await sleep(2000);
    prompt('pinch'); this.worker?.postMessage({ t: 'collect', kind: 'closed' }); await sleep(2000);
    this.worker?.postMessage({ t: 'collect', kind: null });
    const patch = await new Promise<Partial<GestureConfig> | null>(res => {
      this.calResolve = res; this.worker?.postMessage({ t: 'finish-cal' });
    });
    prompt('done', patch ? 'Pinch thresholds personalised' : 'Not enough samples — defaults kept');
  }

  // ---------------------------------------------------------------- internals
  private pump = (): void => {
    if (!this.running) return;
    const v = this.video as any;
    const token = ++this.pumpToken;
    const fire = () => { if (token !== this.pumpToken) return; this.pumpToken++; void this.onFrame(); };
    v.requestVideoFrameCallback ? v.requestVideoFrameCallback(fire) : requestAnimationFrame(fire);
    setTimeout(fire, 200);                          // safety net if the browser throttles frame callbacks
  };

  private onFrame = async (now?: number): Promise<void> => {
    if (this.ready && !this.busy && this.video.readyState >= 2) {
      this.busy = true;
      try {
        const bitmap = await createImageBitmap(this.video);
        this.worker!.postMessage({ t: 'frame', bitmap, ts: performance.now() }, [bitmap]);
      } catch { this.busy = false; }
    }
    this.pump();
  };

  private onWorker(m: any): void {
    switch (m.t) {
      case 'ready': this.step('running'); this.ready = true; this.lastFrameAt = performance.now(); emit('nexus:health', { source: 'gesture', ok: true }); break;
      case 'done': this.busy = false; this.firstFrame = true; this.lastFrameAt = performance.now(); break;
      case 'ev': this.translate(m.ev as GestureEvent); break;
      case 'cal': this.calResolve?.(m.patch); break;
      case 'error': console.error('[gesture worker]', m.message); if (!this.ready) this.fail(m.message); break;
    }
  }

  /** Normalised gesture events -> viewport-pixel DOM events. */
  private translate(ev: GestureEvent): void {
    const W = window.innerWidth, H = window.innerHeight;
    switch (ev.type) {
      case 'state': emit('nexus:gesture-state', { state: ev.state }); break;
      case 'cursor': emit('nexus:cursor', { x: ev.x * W, y: ev.y * H, visible: ev.visible, pinching: ev.pinching }); break;
      case 'nav': emit('nexus:nav', { dir: ev.dir }); break;
      case 'debug': emit('nexus:gesture-debug', { text: ev.text }); break;
      case 'zoom': emit('nexus:zoom', { delta: ev.delta }); break;
      case 'swipe': emit('nexus:swipe', { dir: ev.dir }); break;
      case 'scroll': {
        emit('nexus:scroll', { dy: ev.dy });
        const target = [...document.querySelectorAll<HTMLElement>('[data-nexus-scroll]')].at(-1);
        target?.scrollBy({ top: ev.dy, behavior: 'instant' as ScrollBehavior });
        break;
      }
      case 'tap': {
        const x = ev.x * W, y = ev.y * H;
        emit('nexus:tap', { x, y });
        const el = document.elementFromPoint(x, y) as HTMLElement | null;
        // File cards handle 'nexus:tap' themselves (select / open); everything else gets a real click.
        if (el && !el.closest('[data-file-id]')) {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
        }
        break;
      }
    }
  }

  private async measureLuminance(ms: number): Promise<number> {
    this.scratch.width = 32; this.scratch.height = 24;
    const g = this.scratch.getContext('2d', { willReadFrequently: true })!;
    const samples: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      g.drawImage(this.video, 0, 0, 32, 24);
      const d = g.getImageData(0, 0, 32, 24).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      samples.push(s / (d.length / 4));
      await new Promise(r => setTimeout(r, 100));
    }
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  private fail(reason: string): void {
    reason = `${reason || 'unknown error'}  [failed at step ${this.stage}]`;
    console.error('[gesture] FAILED:', reason);
    this.stop();
    emit('nexus:cursor', { x: 0, y: 0, visible: false, pinching: false });
    emit('nexus:health', { source: 'gesture', ok: false, reason });
  }
}