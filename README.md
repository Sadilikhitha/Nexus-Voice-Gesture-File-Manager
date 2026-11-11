# 🌌 Nexus: Voice & Gesture-Controlled Semantic File Manager

A **touchless, fully offline file manager** that you control with your **voice**, your **hand gestures**, or plain **text and meaning-based search**. Nothing leaves your computer: no cloud APIs, no uploads, no tracking.

Built with **React, TypeScript, Vite, MediaPipe, Vosk and local MiniLM embeddings**, with an optional Electron desktop shell.

---

## ✨ Features

### 🎙️ Voice control (offline)
- Say the wake phrase **"Hey Nexus"** to open a listening session.
- Commands are matched against a restricted grammar for accurate recognition and no accidental actions.
- Examples:
  - `open resume`, `open third file`, `open the file`
  - `go to page 8`, `next page`, `previous page`, `jump to the end`
  - `open pdf`, `open word`, `open images`, `open all`, `open folders`
  - `create folder Work`, `rename file to report`, `copy file`, `move file to Projects`, `delete file`
  - `scroll down`, `zoom in`, `go back`, `close it`
  - `search for budget`

### 🖐️ Gesture control (webcam)
Hand tracking runs in a **Web Worker** so the UI stays smooth.

| Gesture | Action |
|---|---|
| Open palm (hold briefly) | Engage gestures and show the cursor |
| Pinch and release | Air-click (select, open) |
| Fast swipe right to left | Next page or next item |
| Fast swipe left to right | Previous page or back |
| Swipe up or down | Scroll |
| Thumb up + index pointing **left** | **Go back** (previous page, close file, or up one folder) |
| Thumb up + index pointing **right** | Go forward |
| Hold hand at far screen edge (PDF open) | Turn pages |
| Two-finger spread or pinch | Zoom in or out |
| Hold flat open palm | Pause or resume gestures |
| Fist | Disengage |

A **Calibrate** step adapts pinch thresholds to your hand and your lighting.

### 🔍 Semantic search
Local embeddings (**all-MiniLM-L6-v2**) let you search by meaning, such as *"the resume I edited last week"*, instead of exact filenames.

### 🗂️ File management
- New folder, rename, copy and paste, move, delete
- Preview for **PDF, Word (.docx), PowerPoint (.pptx), images, text and code files**
- Filters by type, grid and list views, sorting, zoom
- Keyboard and mouse always work as a fallback

### 🎨 Interface
Glassmorphism UI with live feedback: click ripples, a listening ring, a live transcript, and Voice and Gesture status indicators.

---

## 🧱 Tech Stack

| Area | Technology |
|---|---|
| UI | React 18, TypeScript, Tailwind CSS, Zustand |
| Build | Vite |
| Hand tracking | MediaPipe Tasks Vision (HandLandmarker, WASM) in a Web Worker |
| Speech recognition | Vosk (vosk-browser), offline small English model |
| Semantic search | Hugging Face Transformers.js, all-MiniLM-L6-v2 (ONNX) |
| Document preview | pdf.js, mammoth, JSZip |
| Desktop (optional) | Electron |

---

## 📁 Project Structure

```
src/
├── gesture/     # GestureEngine (landmarks to intent), GestureBridge (camera/worker), worker
├── voice/       # VoiceEngine (Vosk) and CommandParser (grammar and intents)
├── search/      # Semantic search worker and client, time parsing
├── preview/     # PDF / DOCX / PPTX loaders
├── state/       # Zustand store (files, navigation, actions)
├── shared/      # Typed event bus
├── ui/          # Dashboard and PDF viewer
└── fs/          # File system adapter
public/
├── models/      # Offline model files (see below)
└── mediapipe-wasm/
tests/           # Headless tests (gestures, parser, time parsing)
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- A webcam and microphone
- Chrome or Edge (recommended)

### Install
```bash
git clone https://github.com/<your-username>/<your-repo>.git
cd <your-repo>
npm install        # also copies the MediaPipe WASM files into public/
```

### Add the offline models
Nothing is downloaded at runtime. Place these in `public/models/` (details in `public/models/README.md`):

| File | Source |
|---|---|
| `hand_landmarker.task` | MediaPipe HandLandmarker model |
| `vosk-model-small-en-us-0.15.tar.gz` | alphacephei.com/vosk/models |
| `Xenova/all-MiniLM-L6-v2/` (config, tokenizer, `onnx/model_quantized.onnx`) | Hugging Face: `Xenova/all-MiniLM-L6-v2` |

### Run
```bash
npm run dev        # open the local URL in Chrome or Edge
```

Optional desktop app:
```bash
npm run build
npm start          # launches Electron
```

### Test
```bash
npm test
```

---

## 🕹️ How to Use

1. Click **Add files** or **Open folder** (or **Load demo files**).
2. Click **Enable hands-free** and allow camera and microphone access.
3. Wait until **Voice** and **Gesture** show green in the sidebar.
4. Click **Calibrate** once for best accuracy.
5. Show an **open palm** until the cursor appears, then use gestures.
6. Say **"Hey Nexus"**, then a command such as `open pdf` or `go to page 8`.

> **Tip:** a small bar at the bottom shows live gesture detection (which fingers are up, thumb state, pointing direction). It helps when tuning poses.

---

## 🔒 Privacy

All processing happens locally. Camera frames, audio and file contents are never sent anywhere.

---

## ⚠️ Known Limitations

- Old `.doc` and `.ppt` files are not previewed. Save them as `.docx` and `.pptx`.
- Voice recognition uses the small English Vosk model.
- Gesture accuracy depends on lighting and camera position.

---

## 📄 License

Add your license here (for example MIT).
