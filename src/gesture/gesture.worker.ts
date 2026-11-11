/**
 * Gesture worker: MediaPipe HandLandmarker + GestureEngine, entirely off the UI thread.
 * Main thread posts ImageBitmaps (transferred, zero-copy); worker posts back tiny
 * GestureEvents only. Backpressure: main sends the next frame only after 'done'.
 */
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { GestureEngine, type GestureConfig } from './GestureEngine';

let landmarker: HandLandmarker | undefined;
let engine: GestureEngine | undefined;

type In =
  | { t: 'init'; wasmPath: string; modelPath: string; delegate?: 'GPU' | 'CPU'; config?: Partial<GestureConfig> }
  | { t: 'frame'; bitmap: ImageBitmap; ts: number }
  | { t: 'config'; config: Partial<GestureConfig> }
  | { t: 'collect'; kind: 'open' | 'closed' | null }
  | { t: 'finish-cal' }
  | { t: 'detection'; conf: number };

self.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data;
  try {
    switch (m.t) {
      case 'init': {
        // This is an ES-module worker, where importScripts() is unavailable. The classic MediaPipe loader
        // then gets import()-ed as a module and never sets self.ModuleFactory ("ModuleFactory not set").
        // `true` selects the *_module_internal loader, which sets globalThis.ModuleFactory itself.
        const fileset = await FilesetResolver.forVisionTasks(m.wasmPath, true);
        const make = (delegate: 'GPU' | 'CPU') => HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: m.modelPath, delegate },
          runningMode: 'VIDEO', numHands: 1,
          minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        });
        if (m.delegate === 'CPU') landmarker = await make('CPU');
        else { try { landmarker = await make('GPU'); } catch { landmarker = await make('CPU'); } }
        engine = new GestureEngine(ev => (self as any).postMessage({ t: 'ev', ev }), m.config);
        (self as any).postMessage({ t: 'ready' });
        break;
      }
      case 'frame': {
        const res = landmarker!.detectForVideo(m.bitmap, m.ts);
        m.bitmap.close();
        const lm = res.landmarks?.[0];
        // Use landmarks if present (do not discard hand over left/right handedness classification)
        engine!.process(lm && lm.length >= 21 ? lm : null, m.ts);
        (self as any).postMessage({ t: 'done' });
        break;
      }
      case 'config': engine?.setConfig(m.config); break;
      case 'collect': engine?.collect(m.kind); break;
      case 'finish-cal': (self as any).postMessage({ t: 'cal', patch: engine?.finishCalibration() ?? null }); break;
      case 'detection': await landmarker?.setOptions({ minHandDetectionConfidence: m.conf, minHandPresenceConfidence: m.conf }); break;
    }
  } catch (err) {
    (self as any).postMessage({ t: 'error', message: String((err as Error)?.message ?? err) });
    if (m.t === 'frame') (self as any).postMessage({ t: 'done' });
  }
};