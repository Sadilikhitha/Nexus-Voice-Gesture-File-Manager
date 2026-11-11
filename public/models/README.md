# Offline model files (nothing is downloaded at runtime)

| File / folder | Source | Used by |
|---|---|---|
| `hand_landmarker.task` | already included (taken from your prototype's `data/pretrained_models/`) | gesture worker |
| `vosk-model-small-en-us-0.15.tar.gz` | alphacephei.com/vosk/models (small English model, ~40 MB; it supports runtime grammars) | VoiceEngine |
| `Xenova/all-MiniLM-L6-v2/` (`config.json`, `tokenizer.json`, `tokenizer_config.json`, `onnx/model_quantized.onnx`) | Hugging Face repo `Xenova/all-MiniLM-L6-v2` | semantic worker |

Fetch the last two once on a connected machine and ship them with the app.
