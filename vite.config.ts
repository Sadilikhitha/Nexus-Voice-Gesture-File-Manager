import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './', // Electron loads from file://
  // Workers use standard ES module format supported in modern Chromium/Electron.
  worker: { format: 'es' },
  build: { target: 'chrome126' },
  server: {
    headers: {
      // Needed for SharedArrayBuffer-backed WASM threads (faster ONNX / Vosk).
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
