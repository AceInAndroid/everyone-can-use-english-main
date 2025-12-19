/* global Module, createOnlineRecognizer */

let recognizer = null;
let offlineRecognizer = null;
let expectedSampleRate = 16000;
let initPromise = null;

const reply = (msg) => self.postMessage(msg);

const getErrorMessage = (err) => {
  if (err && typeof err.message === "string") return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

const fetchUint8 = async (url) => {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch: ${url}`);
  return new Uint8Array(await resp.arrayBuffer());
};

const init = async (payload) => {
  expectedSampleRate = payload.sampleRate || 16000;
  const base = payload.baseUrl || "";

  const wasmBinary = await (await fetch(payload.wasmUrl)).arrayBuffer();

  // Prevent the bundled demo data package loader from running.
  self.Module = {
    wasmBinary,
    locateFile: (path) => `${base}${path}`,
    onRuntimeInitialized: () => {
      // no-op; resolved via promise below
    },
  };

  await new Promise((resolve, reject) => {
    self.Module.onRuntimeInitialized = resolve;
    try {
      importScripts(
        payload.runtimeJsUrl,
        payload.asrJsUrl
      );
    } catch (e) {
      reject(e);
    }
  });

  if (typeof self.Module.FS_createPath === "function") {
    try {
      self.Module.FS_createPath("/", "local", true, true);
    } catch {
      // ignore
    }
  }

  const mountFile = async (url, dirPrefix) => {
    const fileName = url.split("/").pop() || url;
    const data = await fetchUint8(url);

    if (typeof self.Module.FS_createDataFile !== "function") {
      throw new Error("FS_createDataFile is not available on the Sherpa module");
    }

    // Create files in Emscripten FS so C++ `Validate()` can see them.
    // Use absolute paths to avoid any working-directory ambiguity.
    const fullPath = `${dirPrefix}/${fileName}`;
    try {
      if (typeof self.Module.FS_unlink === "function") {
        self.Module.FS_unlink(fullPath);
      }
    } catch {
      // ignore
    }
    self.Module.FS_createDataFile(fullPath, null, data, true, true, true);
    return fullPath;
  };

  const localEncoder = await mountFile(payload.model.encoder, "/local");
  const localDecoder = await mountFile(payload.model.decoder, "/local");
  const localJoiner = await mountFile(payload.model.joiner, "/local");
  const localTokens = await mountFile(payload.model.tokens, "/local");

  const makeConfig = (paths) => ({
    featConfig: { sampleRate: expectedSampleRate, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      paraformer: { encoder: "", decoder: "" },
      zipformer2Ctc: { model: "" },
      tokens: paths.tokens,
      numThreads: payload.numThreads ?? 1,
      provider: "cpu",
      debug: 0,
      modelType: "",
      modelingUnit: "",
      bpeVocab: "",
    },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
    enableEndpoint: 0,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20,
    hotwordsFile: "",
    hotwordsScore: 1.5,
    ctcFstDecoderConfig: { graph: "", maxActive: 3000 },
    ruleFsts: "",
    ruleFars: "",
  });

  if (typeof self.createOnlineRecognizer !== "function") {
    throw new Error("createOnlineRecognizer is not available after loading sherpa scripts");
  }

  recognizer = self.createOnlineRecognizer(
    self.Module,
    makeConfig({
      encoder: localEncoder,
      decoder: localDecoder,
      joiner: localJoiner,
      tokens: localTokens,
    })
  );

  const makeOfflineConfig = (paths) => ({
    featConfig: { sampleRate: expectedSampleRate, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: paths.encoder,
        decoder: paths.decoder,
        joiner: paths.joiner,
      },
      paraformer: { model: "" },
      zipformer2Ctc: { model: "" },
      nemoCtc: { model: "" },
      whisper: { encoder: "", decoder: "" },
      tdnn: { model: "" },
      senseVoice: { model: "" },
      moonshine: { encoder: "", decoder: "" },
      fireRedAsr: { encoder: "", decoder: "" },
      dolphin: { encoder: "", decoder: "" },
      tokens: paths.tokens,
      numThreads: payload.numThreads ?? 1,
      provider: "cpu",
      debug: 0,
      modelType: "",
      modelingUnit: "",
      bpeVocab: "",
    },
    lmConfig: { model: "", scale: 1.0 },
    hr: { dictDir: "", lexicon: "", ruleFsts: "" },
    decodingMethod: "greedy_search",
    maxActivePaths: 4,
    hotwordsFile: "",
    hotwordsScore: 1.5,
    ruleFsts: "",
    ruleFars: "",
    blankPenalty: 0,
  });

  if (typeof self.OfflineRecognizer === "function") {
    try {
      offlineRecognizer = new self.OfflineRecognizer(
        makeOfflineConfig({
          encoder: localEncoder,
          decoder: localDecoder,
          joiner: localJoiner,
          tokens: localTokens,
        }),
        self.Module
      );
    } catch (err) {
      console.warn("Failed to initialize Sherpa offline recognizer", err);
      offlineRecognizer = null;
    }
  }
};

const transcribe = (payload) => {
  if (!recognizer) throw new Error("Recognizer not initialized");
  const stream = recognizer.createStream();
  stream.acceptWaveform(expectedSampleRate, payload.samples);
  stream.inputFinished();

  // Drain the decoder.
  let guard = 0;
  while (recognizer.isReady(stream) && guard < 100000) {
    recognizer.decode(stream);
    guard += 1;
  }

  const result = recognizer.getResult(stream);
  stream.free();

  return {
    transcript: String(result?.text || ""),
    confidence: result?.confidence,
  };
};

const alignWithOfflineRecognizer = (payload) => {
  if (!offlineRecognizer) {
    throw new Error("Sherpa offline recognizer not initialized");
  }

  const stream = offlineRecognizer.createStream();
  stream.acceptWaveform(expectedSampleRate, payload.samples);
  offlineRecognizer.decode(stream);
  const result = offlineRecognizer.getResult(stream);
  stream.free?.();

  return {
    alignment: result,
    duration: payload.samples.length / expectedSampleRate,
  };
};

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    if (msg.type === "init") {
      if (!initPromise) initPromise = init(msg.payload);
      await initPromise;
      reply({ type: "inited" });
      return;
    }

    if (msg.type === "transcribe") {
      if (!initPromise) throw new Error("Worker not initialized");
      await initPromise;
      const out = transcribe(msg.payload);
      reply({ type: "result", id: msg.id, payload: out });
      return;
    }
    if (msg.type === "align") {
      if (!initPromise) throw new Error("Worker not initialized");
      await initPromise;
      const out = alignWithOfflineRecognizer(msg.payload);
      reply({ type: "alignment", id: msg.id, payload: out });
      return;
    }
  } catch (err) {
    reply({ type: "error", id: msg?.id, error: getErrorMessage(err) });
  }
};
