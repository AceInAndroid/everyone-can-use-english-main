type InitMessage = {
  type: "init";
  payload: {
    wasmUrl: string;
    model: {
      encoder: string;
      decoder: string;
      joiner: string;
      tokens: string;
    };
    sampleRate: number;
    numThreads?: number;
  };
};

type TranscribeMessage = {
  type: "transcribe";
  id: number;
  payload: {
    samples: Float32Array;
    sampleRate: number;
  };
};

type IncomingMessage = InitMessage | TranscribeMessage;

type OutgoingMessage =
  | { type: "inited" }
  | { type: "result"; id: number; payload: { transcript: string; confidence?: number } }
  | { type: "error"; id?: number; error: string };

let recognizer: any | null = null;
let moduleInstance: any | null = null;
let expectedSampleRate = 16000;

const getErrorMessage = (err: unknown) => {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const post = (msg: OutgoingMessage) => {
  (self as any).postMessage(msg);
};

const initRecognizer = async (payload: InitMessage["payload"]) => {
  expectedSampleRate = payload.sampleRate;

  const sherpa: any = await import("@sherpa-onnx-wasm/asr");
  const ModuleFactory = sherpa.AsrModule?.default;
  if (typeof ModuleFactory !== "function") {
    throw new Error("Failed to load Sherpa ASR WASM module factory");
  }

  const wasmBinary = await (await fetch(payload.wasmUrl)).arrayBuffer();
  moduleInstance = await ModuleFactory({
    wasmBinary,
  });
  moduleInstance.MountedFiles = moduleInstance.MountedFiles || new Map();

  const mountFile = async (url: string) => {
    const fileName = url.split("/").pop() || url;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load model file: ${url}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    moduleInstance.MountedFiles.set(fileName, buf);
    return `./${fileName}`;
  };

  const encoderPath = await mountFile(payload.model.encoder);
  const decoderPath = await mountFile(payload.model.decoder);
  const joinerPath = await mountFile(payload.model.joiner);
  const tokensPath = await mountFile(payload.model.tokens);

  const config = {
    featConfig: {
      sampleRate: payload.sampleRate,
      featureDim: 80,
    },
    modelConfig: {
      transducer: {
        encoder: encoderPath,
        decoder: decoderPath,
        joiner: joinerPath,
      },
      tokens: tokensPath,
      numThreads: payload.numThreads ?? 1,
    },
  };

  if (typeof sherpa.OfflineRecognizer !== "function") {
    throw new Error("Unsupported sherpa-onnx-wasm ASR API: OfflineRecognizer missing");
  }

  recognizer = new sherpa.OfflineRecognizer(config, moduleInstance);
};

const transcribe = async (payload: TranscribeMessage["payload"]) => {
  if (!recognizer) throw new Error("Recognizer not initialized");

  const stream = recognizer.createStream();
  stream.acceptWaveform(expectedSampleRate, payload.samples);
  recognizer.decode(stream);
  const result: any = recognizer.getResult(stream);
  stream.free?.();

  const transcript = result?.text || "";
  // sherpa json includes tokens/confidence in some models; keep optional.
  const confidence = result?.confidence ?? undefined;
  return { transcript: String(transcript || ""), confidence };
};

self.onmessage = async (event: MessageEvent<IncomingMessage>) => {
  try {
    const msg = event.data;
    if (msg.type === "init") {
      await initRecognizer(msg.payload);
      post({ type: "inited" });
      return;
    }
    if (msg.type === "transcribe") {
      const out = await transcribe(msg.payload);
      post({ type: "result", id: msg.id, payload: out });
      return;
    }
  } catch (err) {
    const msg = (event as any)?.data;
    post({ type: "error", id: msg?.id, error: getErrorMessage(err) });
  }
};
