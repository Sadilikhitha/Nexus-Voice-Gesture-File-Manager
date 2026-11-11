// Copies MediaPipe's WASM runtime next to the app so nothing is fetched from a CDN.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
const src = 'node_modules/@mediapipe/tasks-vision/wasm', dst = 'public/mediapipe-wasm';
if (existsSync(src)) { mkdirSync(dst, { recursive: true }); cpSync(src, dst, { recursive: true }); console.log('copied MediaPipe wasm ->', dst); }
