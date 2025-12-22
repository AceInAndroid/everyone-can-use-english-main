import { createRoot } from "react-dom/client";
import { env as ortEnv } from "onnxruntime-web";
import App from "./app";
import "./i18n";

// Configure ORT wasm asset paths for both dev (http://localhost) and file:// in production.
const ortBase = import.meta.env.DEV
  ? `${window.location.origin}/assets/ort/`
  : new URL("./assets/ort/", import.meta.url).toString();

ortEnv.wasm.wasmPaths = {
  "ort-wasm-simd-threaded.wasm": `${ortBase}ort-wasm-simd-threaded.wasm`,
  "ort-wasm-simd.wasm": `${ortBase}ort-wasm-simd.wasm`,
  "ort-wasm.wasm": `${ortBase}ort-wasm.wasm`,
};

const root = createRoot(document.getElementById("app"));
root.render(<App />);
