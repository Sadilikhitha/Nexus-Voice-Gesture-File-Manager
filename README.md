# Nexus FM
```
npm install            # also copies MediaPipe WASM into public/
# place the Vosk model + MiniLM files per public/models/README.md
npm run dev            # then in another shell: VITE_DEV_SERVER_URL=http://localhost:5173 npx electron .
npm test               # 20 headless tests (gestures, parser, time parsing)
```
Click **Enable hands-free**, then **Calibrate**. Say "Hey Nexus" → "open resume". Hold an open palm to engage gestures.

**Verify on first run** (written against docs/memory, not executed here): `vosk-browser` API names (`KaldiRecognizer(sampleRate, grammar)`, `acceptWaveformFloat`), and MediaPipe's WASM loading inside a classic worker (`worker.format: 'iife'` in vite.config.ts).
