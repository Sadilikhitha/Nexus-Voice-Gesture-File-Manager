# Nexus — Offline Multi-Modal Semantic File Manager

## 1. Stack (all local, zero cloud)

| Concern | Choice | Why |
|---|---|---|
| Shell | **Electron 31** (sandboxed renderer, `media` permission only, request blocker) | Real FS access later via IPC; Chromium gives GPU WebGL for MediaPipe and AudioWorklet |
| UI | **React 18 + Tailwind 3 + Zustand** | One store, many input sources; Zustand has no provider overhead |
| Hand tracking | **MediaPipe Tasks `HandLandmarker`** (GPU delegate, CPU fallback) in a **Web Worker** | 21 landmarks, 1 hand, ~10-30 ms/frame |
| Gesture logic | **`GestureEngine`** (pure TS state machine) + One-Euro filter | Deterministic, unit-tested, no ML training needed to ship |
| Voice | **AudioWorklet energy gate → Vosk-browser (WASM)** with runtime grammars | Offline, grammar-constrained decoding is the strongest cheap false-positive filter |
| Semantic search / tagging | **Transformers.js, all-MiniLM-L6-v2 (q8, ONNX-WASM)** in a Web Worker | 384-d embeddings, ~25 MB, fast on CPU |
| Tests | `node:test` + `tsx` | Pure modules run headless |

## 2. Threads and data flow

```
 MAIN THREAD (React, 60 FPS)            WORKERS / RENDER THREADS
 ───────────────────────────            ─────────────────────────────────────────────
 <video> ──ImageBitmap(transfer)──────▶ gesture.worker: HandLandmarker → GestureEngine
 GestureBridge ◀──── tiny GestureEvents ─┘    (drops frames if busy: no queue, no lag)
      │ px-space DOM events: nexus:cursor|scroll|zoom|tap|swipe
      ▼
 window event bus ───▶ Dashboard (cursor moved via ref, ripples, ring)  ───▶ Zustand actions
      ▲                                                                      ▲   ▲
 nexus:command|wake|partial                                      keyboard ───┘   │ mouse
      │                                                                          │
 VoiceEngine ◀──Float32 speech chunks── audio-gate.worklet (render thread)       │
      │  └─ Vosk model runs in its own worker (vosk-browser)                     │
      └─ CommandParser (anchored grammar) ───────────────────────────────────────┘
 SemanticClient ◀──RPC──▶ semantic.worker: MiniLM embeddings, cosine search, tagging
```

Nothing heavy touches the main thread: camera inference, speech decoding, embeddings and the audio gate are all off-thread. The main thread does one `createImageBitmap` per frame, DOM event dispatch and CSS-transform updates.

**Estimated** tap-to-ripple latency (to be measured with `performance.now()` on target hardware): camera 33 ms + bitmap 2 ms + inference 10–30 ms + engine <0.1 ms + messaging <1 ms + paint 16 ms ≈ **60–85 ms**.

## 3. Near-zero false positives

**Gesture** (`GestureEngine.ts`): engagement gate (open palm held 450 ms; fist or 1.2 s without a hand releases) → nothing fires while idle; palm-size-normalised, rotation-invariant geometry; pinch hysteresis; pose debounce; swipe needs distance + speed + horizontal dominance; tap needs short duration + low travel; scroll dead zone; refractory periods; return-stroke suppression. Tests cover jitter, quick waves, fist, slow drift, long pinch, return strokes.

**Voice** (`VoiceEngine.ts`): L1 adaptive energy gate → L2 closed vocabulary (asleep decoder can only say "hey nexus" or `[unk]`) → L3 wake utterance must be isolated and ≤1.8 s → L4 confidence floors → L5 6 s command window → L6 whole-utterance anchored grammar → L7 ambiguity does nothing → L8 no destructive commands exist. The grammar is rebuilt from the files currently on screen.

## 4. Calibration and fail-safe

- **Voice**: `calibrate()` measures ambient RMS for 2.5 s, sets the gate to ~10 dB above the 90th percentile.
- **Gesture**: lighting check (luminance → detection confidence and smoothing) and personal pinch thresholds from 2 s open / 2 s pinched samples.
- **Hybrid mode**: keyboard and mouse are never disabled. Camera/mic denial, worker errors, or a 3 s camera stall emit `nexus:health {ok:false}`; the UI shows a toast and a "fallback" badge. Semantic search falls back to substring matching if the model fails to load.

## 5. Known limits and upgrade path

- Vosk grammar words must exist in the model lexicon; unusual file names become `[unk]` (use "open third file" for those).
- A grammar-constrained recogniser can still snap similar-sounding speech onto the wake phrase; layers L3-L4 reduce that, a dedicated keyword spotter (e.g. openWakeWord via onnxruntime-web) would reduce it further. Your prototype's ECAPA-TDNN speaker verification could be added as an "only my voice" gate.
- Thresholds in `DEFAULT_GESTURE_CONFIG` are starting points validated on synthetic hands; tune on real users via the calibration step.
- If rule-based gestures plateau, the Bi-LSTM from your prototype can sit behind the same `GestureEvent` interface.

## 6. Lessons taken from your Python prototype (read from the zip)

- `intent_parser.py` matches words like `confirm|yes|stop|cancel` **anywhere** in a sentence; here every pattern is anchored to the whole utterance.
- `gesture_recognizer.py` uses absolute distances (e.g. pinch < 0.065) and "tip above joint in image space"; here distances are palm-normalised and finger extension uses distance-from-wrist, so hand rotation and camera distance don't break it.
- Kept: MiniLM embeddings, ~0.4 s cooldowns, confidence gating.
