import { decodeAudioBlobToMonoFloat32, resampleMono } from "@renderer/lib/audio";

type WorkerOutgoingMessage =
  | { type: "inited" }
  | { type: "result"; id: number; payload: { transcript: string; confidence?: number } }
  | { type: "alignment"; id: number; payload: { alignment: any; duration: number } }
  | { type: "error"; id?: number; error: string };

type PendingRequest =
  | {
      kind: "transcribe";
      resolve: (v: { transcript: string; confidence?: number }) => void;
      reject: (e: Error) => void;
    }
  | {
      kind: "align";
      resolve: (v: { alignment: any; duration: number }) => void;
      reject: (e: Error) => void;
    };

let worker: Worker | null = null;
let inited = false;
let initPromise: Promise<void> | null = null;
let resolveInit: (() => void) | null = null;
let rejectInit: ((e: Error) => void) | null = null;
let nextId = 1;
const pending = new Map<number, PendingRequest>();

const getModelBaseUrl = () => {
  // With Vite `base: "./"`, assets are served relative to the current HTML.
  return new URL("./assets/sherpa-onnx/en-us-small/", window.location.href).toString();
};

const getWasmUrl = () => {
  return new URL(
    "./assets/sherpa-onnx/wasm/sherpa-onnx-wasm-main-asr.wasm",
    window.location.href
  ).toString();
};

const getRuntimeBaseUrl = () => {
  return new URL("./assets/sherpa-onnx/wasm/", window.location.href).toString();
};

const getClassicWorkerUrl = () => {
  return new URL("./assets/workers/sherpa-asr-classic.js", window.location.href).toString();
};

const ensureWorker = () => {
  if (worker) return worker;
  // Classic worker so we can use `importScripts()` for Emscripten bundles.
  worker = new Worker(getClassicWorkerUrl());

  worker.onmessage = (event: MessageEvent<WorkerOutgoingMessage>) => {
    const msg = event.data;
    if (msg.type === "inited") {
      inited = true;
      if (resolveInit) resolveInit();
      initPromise = null;
      resolveInit = null;
      rejectInit = null;
      return;
    }
    if (msg.type === "result" || msg.type === "alignment") {
      const req = pending.get(msg.id);
      if (!req) return;
      const isTranscribe = msg.type === "result" && req.kind === "transcribe";
      const isAlign = msg.type === "alignment" && req.kind === "align";
      if (!isTranscribe && !isAlign) {
        return;
      }
      pending.delete(msg.id);
      req.resolve(msg.payload as any);
      return;
    }
    if (msg.type === "error") {
      if (typeof msg.id === "number") {
        const req = pending.get(msg.id);
        if (!req) return;
        pending.delete(msg.id);
        req.reject(new Error(msg.error));
      } else {
        if (rejectInit) rejectInit(new Error(msg.error));
        initPromise = null;
        resolveInit = null;
        rejectInit = null;
        // Global init error; reject all.
        for (const [id, req] of pending) {
          pending.delete(id);
          req.reject(new Error(msg.error));
        }
      }
    }
  };

  return worker;
};

export const initSherpaWasm = async () => {
  if (inited) return;
  if (initPromise) return initPromise;

  initPromise = new Promise<void>((resolve, reject) => {
    resolveInit = resolve;
    rejectInit = reject;
  });

  const w = ensureWorker();
  const base = getModelBaseUrl();
  const wasmUrl = getWasmUrl();
  const runtimeBase = getRuntimeBaseUrl();
  w.postMessage({
    type: "init",
    payload: {
      wasmUrl,
      baseUrl: runtimeBase,
      runtimeJsUrl: `${runtimeBase}sherpa-onnx-wasm-main-asr.js`,
      asrJsUrl: `${runtimeBase}sherpa-onnx-asr.js`,
      model: {
        encoder: `${base}encoder.onnx`,
        decoder: `${base}decoder.onnx`,
        joiner: `${base}joiner.onnx`,
        tokens: `${base}tokens.txt`,
      },
      sampleRate: 16000,
      numThreads: 1,
    },
  });
  return initPromise;
};

const transcribeSherpaWasmFromPcm = async (samples: Float32Array, sampleRate: number) => {
  const w = ensureWorker();
  await initSherpaWasm();

  const id = nextId++;
  const promise = new Promise<{ transcript: string; confidence?: number }>((resolve, reject) => {
      pending.set(id, { kind: "transcribe", resolve, reject });
  });

  // Transfer underlying buffer to avoid copying large audio arrays.
  w.postMessage(
    {
      type: "transcribe",
      id,
      payload: { samples, sampleRate },
    },
    [samples.buffer]
  );

  return promise;
};

export const transcribeSherpaWasm = async (params: { blob: Blob }) => {
  const { blob } = params;
  const decoded = await decodeAudioBlobToMonoFloat32(blob);
  const mono16k = resampleMono(decoded.samples, decoded.sampleRate, 16000);
  return transcribeSherpaWasmFromPcm(mono16k, 16000);
};

const alignSherpaWasmFromPcm = async (samples: Float32Array, sampleRate: number, transcript: string) => {
  const w = ensureWorker();
  await initSherpaWasm();

  const id = nextId++;
  const promise = new Promise<{ alignment: any; duration: number }>((resolve, reject) => {
    pending.set(id, { kind: "align", resolve, reject });
  });

  w.postMessage(
    {
      type: "align",
      id,
      payload: { samples, sampleRate, transcript },
    },
    [samples.buffer]
  );

  return promise;
};

export const alignSherpaWasm = async (params: { blob: Blob; transcript: string }) => {
  const { blob, transcript } = params;
  const decoded = await decodeAudioBlobToMonoFloat32(blob);
  const mono16k = resampleMono(decoded.samples, decoded.sampleRate, 16000);
  return alignSherpaWasmFromPcm(mono16k, 16000, transcript);
};

export const checkSherpaWasmModel = async () => {
  await initSherpaWasm();
  // A tiny transcription call to make sure the WASM + model files are loadable.
  await transcribeSherpaWasmFromPcm(new Float32Array(16000), 16000);
};
