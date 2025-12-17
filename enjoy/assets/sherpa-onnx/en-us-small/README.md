This directory contains the built-in English Sherpa-ONNX model (WASM) bundled with the app.

Current model:

- `sherpa-onnx-streaming-zipformer-en-2023-06-26-mobile` (encoder/joiner int8)

Expected files (Transducer):

- `encoder.onnx`
- `decoder.onnx`
- `joiner.onnx`
- `tokens.txt`

At runtime, the renderer loads them from `assets/sherpa-onnx/en-us-small/`.

Note: Model files are large; consider using Git LFS if you plan to commit them.
