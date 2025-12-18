import { app, ipcMain } from "electron";
import { execSync, spawn } from "child_process";
import * as Echogarden from "echogarden/dist/api/API.js";
import { AlignmentOptions, RecognitionOptions } from "echogarden/dist/api/API";
import {
  encodeRawAudioToWave,
  decodeWaveToRawAudio,
  ensureRawAudio,
  getRawAudioDuration,
  trimAudioStart,
  trimAudioEnd,
  AudioSourceParam,
} from "echogarden/dist/audio/AudioUtilities.js";
import { wordTimelineToSegmentSentenceTimeline } from "echogarden/dist/utilities/Timeline.js";
import {
  type Timeline,
  type TimelineEntry,
} from "echogarden/dist/utilities/Timeline.d.js";
import {
  ensureAndGetPackagesDir,
  loadPackage,
} from "echogarden/dist/utilities/PackageManager.js";
import path from "path";
import log from "@main/logger";
import url from "url";
import settings from "@main/settings";
import fs from "fs-extra";
import ffmpegPath from "ffmpeg-static";
import { enjoyUrlToPath, pathToEnjoyUrl } from "./utils";
import axios from "axios";
import unzipper from "unzipper";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { randomBytes } from "crypto";

Echogarden.setGlobalOption(
  "ffmpegPath",
  ffmpegPath.replace("app.asar", "app.asar.unpacked")
);
const ffmpegExecutable = ffmpegPath.replace("app.asar", "app.asar.unpacked");
if (process.platform === "darwin" && app.isPackaged) {
  if (!fs.existsSync(ffmpegExecutable)) {
    log.error(`FFmpeg executable not found at: ${ffmpegExecutable}`);
  } else {
    try {
      fs.accessSync(ffmpegExecutable, fs.constants.X_OK);
      log.info(`FFmpeg executable verified at: ${ffmpegExecutable}`);
    } catch (err) {
      log.error(`FFmpeg executable no execute permissions: ${ffmpegExecutable}`, err);
    }
  }
}
Echogarden.setGlobalOption(
  "packageBaseURL",
  "https://hf-mirror.com/echogarden/echogarden-packages/resolve/main/"
);

/*
 * sample files will be in /app.asar.unpacked instead of /app.asar
 */
const __dirname = import.meta.dirname.replace("app.asar", "app.asar.unpacked");

const logger = log.scope("echogarden");
class EchogardenWrapper {
  public recognize: typeof Echogarden.recognize;
  public align: typeof Echogarden.align;
  public alignSegments: typeof Echogarden.alignSegments;
  public denoise: typeof Echogarden.denoise;
  public encodeRawAudioToWave: typeof encodeRawAudioToWave;
  public decodeWaveToRawAudio: typeof decodeWaveToRawAudio;
  public ensureRawAudio: typeof ensureRawAudio;
  public getRawAudioDuration: typeof getRawAudioDuration;
  public trimAudioStart: typeof trimAudioStart;
  public trimAudioEnd: typeof trimAudioEnd;
  public wordTimelineToSegmentSentenceTimeline: typeof wordTimelineToSegmentSentenceTimeline;

  private async recognizeWhisperCppWithCoreML(
    inputFile: string,
    options: RecognitionOptions
  ) {
    const whisperCppOptions = (options.whisperCpp || {}) as any;

    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("Core ML is only supported on macOS arm64.");
    }

    const executablePath: string | undefined = whisperCppOptions.executablePath;
    if (!executablePath) {
      throw new Error("whisper.cpp executablePath is not set.");
    }

    const modelIdRaw: string | undefined = whisperCppOptions.model;
    if (!modelIdRaw) {
      throw new Error("No whisper.cpp model selected.");
    }
    const modelId = modelIdRaw === "large" ? "large-v2" : modelIdRaw;

    // Model package directory used by echogarden is `whisper.cpp-<modelId>`.
    const modelDir = await loadPackage(`whisper.cpp-${modelId}`);
    const modelPath = path.join(modelDir, `ggml-${modelId}.bin`);
    const coreMLDir = path.join(modelDir, `ggml-${modelId}-encoder.mlmodelc`);

    if (!fs.existsSync(modelPath)) {
      throw new Error(`Whisper.cpp model not found: ${modelPath}`);
    }

    // "Force" Core ML by requiring the compiled encoder exists and running with
    // cwd set to the model directory (some builds look for the encoder bundle
    // next to the model).
    if (!fs.existsSync(coreMLDir)) {
      throw new Error(
        `Core ML encoder model not found: ${coreMLDir}. Please download it in Settings > AI > STT > Whisper.cpp.`
      );
    }

    // Ensure the binary was built with Core ML runtime libs shipped alongside.
    const coreMLDylib = path.join(
      path.dirname(executablePath),
      "lib",
      "libwhisper.coreml.dylib"
    );
    if (!fs.existsSync(coreMLDylib)) {
      throw new Error(
        `Core ML runtime library not found: ${coreMLDylib}. Please rebuild whisper.cpp with Core ML support.`
      );
    }

    const rawAudio = await this.ensureRawAudio(inputFile, 16000);
    const sourceAsWave = this.encodeRawAudioToWave(rawAudio);

    const outBase = path.join(
      settings.cachePath(),
      `whispercpp-${Date.now()}-${randomBytes(6).toString("hex")}`
    );
    const outJsonPath = `${outBase}.json`;

    const language = (options as any).language || "auto";
    const threads = whisperCppOptions.threadCount ?? 4;
    const processors = whisperCppOptions.splitCount ?? 1;
    const bestOf = whisperCppOptions.topCandidateCount ?? 5;
    const beamSize = whisperCppOptions.beamCount ?? 5;
    const repetitionThreshold = whisperCppOptions.repetitionThreshold ?? 2.4;
    const temperature = whisperCppOptions.temperature ?? 0.0;
    const temperatureIncrement = whisperCppOptions.temperatureIncrement ?? 0.2;

    // Keep DTW disabled for Core ML builds (timestamps come from JSON output).
    // Force flash attention on: some Core ML builds default it on; making it
    // explicit keeps behavior consistent.
    const args: string[] = [
      "--output-json-full",
      "--output-file",
      outBase,
      "--model",
      modelPath,
      "--language",
      language,
      "--threads",
      `${threads}`,
      "--processors",
      `${processors}`,
      "--best-of",
      `${bestOf}`,
      "--beam-size",
      `${beamSize}`,
      "--entropy-thold",
      `${repetitionThreshold}`,
      "--temperature",
      `${temperature}`,
      "--temperature-inc",
      `${temperatureIncrement}`,
      "--max-len",
      "0",
      "--flash-attn",
    ];

    if (whisperCppOptions.prompt) {
      args.push("--prompt", String(whisperCppOptions.prompt));
    }

    // Do NOT add --no-gpu for Core ML. Core ML uses ANE/GPU internally.

    logger.info(
      `whisper.cpp(coreml) cmd: "${executablePath}" ${args.join(" ")} -`
    );

    const stderrChunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const child = spawn(executablePath, [...args, "-"], {
        cwd: modelDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      child.on("error", reject);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderrChunks.push(String(chunk));
      });

      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`whisper.cpp exited with code ${code}`));
      });

      child.stdin.end(sourceAsWave);
    }).catch((err) => {
      const stderr = stderrChunks.join("").trim();
      if (stderr) {
        throw new Error(`${String(err?.message || err)}\n${stderr}`);
      }
      throw err;
    });

    if (!fs.existsSync(outJsonPath)) {
      throw new Error(`whisper.cpp output JSON not found: ${outJsonPath}`);
    }

    const resultObject = fs.readJsonSync(outJsonPath) as any;
    try {
      fs.removeSync(outJsonPath);
    } catch {
      // ignore
    }

    const segmentTimeline: any[] = [];
    let transcript = "";

    const transcription = Array.isArray(resultObject?.transcription)
      ? resultObject.transcription
      : [];
    for (const segment of transcription) {
      const text = String(segment?.text || "").trim();
      const fromMs = segment?.offsets?.from;
      const toMs = segment?.offsets?.to;
      const startTime =
        typeof fromMs === "number" && Number.isFinite(fromMs) ? fromMs / 1000 : 0;
      const endTime =
        typeof toMs === "number" && Number.isFinite(toMs) ? toMs / 1000 : startTime;

      if (text) {
        transcript += (transcript ? " " : "") + text;
      }

      segmentTimeline.push({
        type: "segment",
        text,
        startTime,
        endTime,
        timeline: [],
      });
    }

    return {
      transcript,
      timeline: segmentTimeline,
    };
  }

  constructor() {
    this.recognize = (sampleFile: string, options: RecognitionOptions) => {
      if (!options) {
        throw new Error("No config options provided");
      }
      return new Promise((resolve, reject) => {
        const handler = (reason: any) => {
          // Remove the handler after it's triggered
          process.removeListener("unhandledRejection", handler);
          reject(reason);
        };

        // Add temporary unhandledRejection listener
        process.on("unhandledRejection", handler);

        // Set the whisper executable path for macOS
        if (process.platform === "darwin") {
          options.whisperCpp = options.whisperCpp || {};
          options.whisperCpp.executablePath = path.join(
            __dirname,
            "lib",
            "whisper",
            "main"
          );

          // ...
          logger.info(
            "Using whisper executable at:",
            options.whisperCpp.executablePath
          );
          if (!fs.existsSync(options.whisperCpp.executablePath)) {
            logger.error(
              "Whisper executable not found at:",
              options.whisperCpp.executablePath
            );
          } else {
            // Check permissions and execution
            try {
              fs.accessSync(
                options.whisperCpp.executablePath,
                fs.constants.X_OK
              );
              logger.info("Whisper executable has execute permissions.");

              // Helper to run command safely
              try {
                const output = execSync(`"${options.whisperCpp.executablePath}" --help`).toString();
                if (output.includes("usage")) {
                  logger.info("Whisper executable verification successful (help command ran).");
                } else {
                  logger.warn("Whisper executable ran but output was unexpected:", output.substring(0, 100));
                }
              } catch (execErr) {
                // whisper -h might return non-zero sometimes? usually 0.
                // If it returns non-zero but prints usage, it might be fine, but execSync throws.
                logger.warn("Whisper executable run check failed or returned non-zero:", execErr.message);
              }

            } catch (err) {
              logger.error(
                "Whisper executable check failed:",
                err
              );
            }
          }

          // Neural Engine (Core ML) support
          // Note: The whisper.cpp binary must be compiled with Core ML support.
          // In Mac M-series, if enableCoreML is set, we ensure GPU is enabled (Core ML uses ANE/GPU).
          if ((options.whisperCpp as any).enableCoreML) {
            options.whisperCpp.enableGPU = true;
            // Core ML binary enables Flash Attention by default which conflicts with DTW
            // We must disable DTW to ensure timestamps are parsed correctly from the standard output
            (options.whisperCpp as any).enableDTW = false;
          }
        }

        // If Core ML is requested for whisper.cpp on Apple Silicon, run the
        // bundled binary directly so we can "force" Core ML by validating the
        // encoder bundle and executing from the model directory.
        const useCoreMLWhisperCpp =
          options.engine === "whisper.cpp" &&
          process.platform === "darwin" &&
          process.arch === "arm64" &&
          Boolean((options.whisperCpp as any)?.enableCoreML);

        const recognizer = useCoreMLWhisperCpp
          ? this.recognizeWhisperCppWithCoreML(sampleFile, options)
          : Echogarden.recognize(sampleFile, options);

        // Call the original recognize function
        Promise.resolve(recognizer)
          .then((result) => {
            // Remove the handler if successful
            process.removeListener("unhandledRejection", handler);
            resolve(result);
          })
          .catch(reject);
      });
    };
    this.align = (input, transcript, options) => {
      if (!options) {
        throw new Error("No config options provided");
      }
      return new Promise((resolve, reject) => {
        const handler = (reason: any) => {
          // Remove the handler after it's triggered
          process.removeListener("unhandledRejection", handler);
          reject(reason);
        };

        // Add temporary unhandledRejection listener
        process.on("unhandledRejection", handler);

        Echogarden.align(input, transcript, options)
          .then((result) => {
            // Remove the handler if successful
            process.removeListener("unhandledRejection", handler);
            resolve(result);
          })
          .catch(reject);
      });
    };
    this.alignSegments = (input, timeline, options) => {
      if (!options) {
        throw new Error("No config options provided");
      }
      return new Promise((resolve, reject) => {
        const handler = (reason: any) => {
          // Remove the handler after it's triggered
          process.removeListener("unhandledRejection", handler);
          reject(reason);
        };

        // Add temporary unhandledRejection listener
        process.on("unhandledRejection", handler);

        Echogarden.alignSegments(input, timeline, options)
          .then((result) => {
            // Remove the handler if successful
            process.removeListener("unhandledRejection", handler);
            resolve(result);
          })
          .catch(reject);
      });
    };
    this.denoise = Echogarden.denoise;
    this.encodeRawAudioToWave = encodeRawAudioToWave;
    this.decodeWaveToRawAudio = decodeWaveToRawAudio;
    this.ensureRawAudio = ensureRawAudio;
    this.getRawAudioDuration = getRawAudioDuration;
    this.trimAudioStart = trimAudioStart;
    this.trimAudioEnd = trimAudioEnd;
    this.wordTimelineToSegmentSentenceTimeline =
      wordTimelineToSegmentSentenceTimeline;
  }

  async check(options: RecognitionOptions) {
    options = options || {
      engine: "whisper",
      whisper: {
        model: "tiny.en",
      },
      whisperCpp: {
        model: "tiny.en",
      },
    };
    const sampleFile = path.join(__dirname, "samples", "jfk.wav");

    try {
      logger.info("echogarden-check:", options);
      const result = await this.recognize(sampleFile, options);
      logger.info("transcript:", result?.transcript);
      fs.writeJsonSync(
        path.join(settings.cachePath(), "echogarden-check.json"),
        result,
        { spaces: 2 }
      );

      const timeline = await this.align(sampleFile, result.transcript, {
        language: "en",
      });
      logger.info("timeline:", !!timeline);

      return { success: true, log: "" };
    } catch (e) {
      logger.error(e);
      return { success: false, log: e.message };
    }
  }

  async checkModel(options: RecognitionOptions) {
    options = options || {
      engine: "whisper",
      whisper: { model: "tiny.en" },
      whisperCpp: { model: "tiny.en" },
    };

    const packagesDir = await ensureAndGetPackagesDir();
    const engine = options.engine || "whisper";
    const model =
      engine === "whisper.cpp"
        ? options.whisperCpp?.model || options.whisper?.model
        : options.whisper?.model || options.whisperCpp?.model;

    if (!model) {
      return { success: false, log: "No whisper model selected." };
    }

    try {
      const entries = await fs.readdir(packagesDir);
      const prefix = `whisper-${model}-`;
      const matched = entries
        .filter((name) => name.startsWith(prefix))
        .sort()
        .reverse();

      if (matched.length === 0) {
        return {
          success: false,
          log: `Whisper model package not found in ${packagesDir}: ${model}`,
        };
      }

      const fullPath = path.join(packagesDir, matched[0]);
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) {
        return {
          success: false,
          log: `Whisper model path is not a directory: ${fullPath}`,
        };
      }

      return { success: true, log: matched[0] };
    } catch (e) {
      logger.error(e);
      return { success: false, log: e.message };
    }
  }

  async checkAlign(options: AlignmentOptions) {
    options = options || {
      language: "en",
    };
    const sampleFile = path.join(__dirname, "samples", "jfk.wav");
    const transcript =
      "And so my fellow Americans ask not what your country can do for you ask what you can do for your country.";
    try {
      const timeline = await this.align(sampleFile, transcript, options);
      logger.info("timeline:", !!timeline);
      return { success: true, log: "" };
    } catch (e) {
      logger.error(e);
      return { success: false, log: e.message };
    }
  }

  /**
   * Transcodes the audio file at the enjoy:// protocol URL into a WAV format.
   * @param url - The URL of the audio file to transcode.
   * @returns A promise that resolves to the enjoy:// protocal URL of the transcoded WAV file.
   */
  async transcode(
    url: string,
    sampleRate: number | null = 16000
  ): Promise<string> {
    sampleRate = sampleRate || 16000;
    logger.info("echogarden-transcode:", url, sampleRate);
    const filePath = enjoyUrlToPath(url);
    const rawAudio = await this.ensureRawAudio(filePath, sampleRate);
    const audioBuffer = this.encodeRawAudioToWave(rawAudio);

    const outputFilePath = path.join(settings.cachePath(), `${Date.now()}.wav`);
    fs.writeFileSync(outputFilePath, audioBuffer);

    return pathToEnjoyUrl(outputFilePath);
  }

  registerIpcHandlers() {
    ipcMain.handle(
      "echogarden-recognize",
      async (_event, url: string, options: RecognitionOptions) => {
        logger.info("echogarden-recognize:", options);
        try {
          const input = enjoyUrlToPath(url);
          return await this.recognize(input, options);
        } catch (err) {
          logger.error(err);
          throw err;
        }
      }
    );

    ipcMain.handle(
      "echogarden-align",
      async (
        _event,
        input: AudioSourceParam,
        transcript: string,
        options: AlignmentOptions
      ) => {
        logger.info("echogarden-align:", options);
        try {
          return await this.align(input, transcript, options);
        } catch (err) {
          logger.error(err);
          throw err;
        }
      }
    );

    ipcMain.handle(
      "echogarden-align-segments",
      async (
        _event,
        input: AudioSourceParam,
        timeline: Timeline,
        options: AlignmentOptions
      ) => {
        logger.info("echogarden-align-segments:", options);
        if (typeof input === "string") {
          input = enjoyUrlToPath(input);
        }
        try {
          const rawAudio = await this.ensureRawAudio(input, 16000);
          return await this.alignSegments(rawAudio, timeline, options);
        } catch (err) {
          logger.error(err);
          throw err;
        }
      }
    );

    ipcMain.handle(
      "echogarden-word-to-sentence-timeline",
      async (
        _event,
        wordTimeline: Timeline,
        transcript: string,
        language: string
      ) => {
        logger.info("echogarden-word-to-sentence-timeline:", language);

        const { segmentTimeline } =
          await this.wordTimelineToSegmentSentenceTimeline(
            wordTimeline,
            transcript,
            language.split("-")[0]
          );
        const timeline: Timeline = [];
        segmentTimeline.forEach((t: TimelineEntry) => {
          if (t.type === "sentence") {
            timeline.push(t);
          } else {
            t.timeline.forEach((st) => {
              timeline.push(st);
            });
          }
        });

        return timeline;
      }
    );

    ipcMain.handle(
      "echogarden-transcode",
      async (_event, url: string, sampleRate?: number) => {
        logger.info("echogarden-transcode:", url, sampleRate);
        try {
          return await this.transcode(url, sampleRate);
        } catch (err) {
          logger.error(err);
          throw err;
        }
      }
    );

    ipcMain.handle("echogarden-check", async (_event, options: any) => {
      logger.info("echogarden-check:", options);
      return this.check(options);
    });

    ipcMain.handle("echogarden-check-model", async (_event, options: any) => {
      logger.info("echogarden-check-model:", options);
      return this.checkModel(options);
    });

    ipcMain.handle("echogarden-check-align", async (_event, options: any) => {
      logger.info("echogarden-check-align:", options);
      return this.checkAlign(options);
    });

    ipcMain.handle("echogarden-get-packages-dir", async (_event) => {
      return ensureAndGetPackagesDir();
    });
    ipcMain.handle("echogarden-check-coreml-model", async (event, model) => {
      return this.checkCoreMLModel(model);
    });
    ipcMain.handle("echogarden-download-coreml-model", async (event, model) => {
      return this.downloadCoreMLModel(event.sender, model);
    });
    ipcMain.handle("echogarden-get-coreml-model-dir", async (_event, model) => {
      const normalizedModel = model === "large" ? "large-v2" : model;
      const packageName = `whisper.cpp-${normalizedModel}`;
      return await loadPackage(packageName);
    });
  }

  async checkCoreMLModel(model: string) {
    const packageName = `whisper.cpp-${model}`;
    const modelDir = await loadPackage(packageName);
    const modelName = `ggml-${model}-encoder.mlmodelc`;
    const modelPath = path.join(modelDir, modelName);

    // Migration: Check if it's in the root packages dir
    if (!fs.existsSync(modelPath)) {
      const packagesDir = await ensureAndGetPackagesDir();
      const oldPath = path.join(packagesDir, modelName);
      if (fs.existsSync(oldPath)) {
        logger.info(`Migrating Core ML model from ${oldPath} to ${modelPath}`);
        await fs.move(oldPath, modelPath);
        return true;
      }
    }

    return fs.existsSync(modelPath);
  }

  async downloadCoreMLModel(sender: Electron.WebContents, model: string) {
    const packageName = `whisper.cpp-${model}`;
    const modelDir = await loadPackage(packageName);
    const filename = `ggml-${model}-encoder.mlmodelc.zip`;
    const candidateUrls = [
      `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${filename}`,
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${filename}`,
    ];
    const downloadPath = path.join(
      settings.cachePath(),
      filename
    );

    let lastError: unknown;
    for (const url of candidateUrls) {
      try {
        logger.info(`Downloading Core ML model from ${url} to ${downloadPath}`);

        // Best-effort cleanup of any previous partial download.
        try {
          fs.removeSync(downloadPath);
        } catch {
          // ignore
        }

        const response = await axios({
          url,
          method: "GET",
          responseType: "stream",
        });

        const total = parseInt(response.headers["content-length"], 10);
        let received = 0;

        response.data.on("data", (chunk: Buffer) => {
          received += chunk.length;
          sender.send("echogarden-download-coreml-model-progress", {
            received,
            total,
            state: "downloading",
          });
        });

        await pipeline(response.data, createWriteStream(downloadPath));
        logger.info(`Downloaded ${downloadPath}`);

        // Unzip to modelDir
        sender.send("echogarden-download-coreml-model-progress", {
          received: total,
          total,
          state: "unzipping",
        });
        logger.info(`Unzipping ${downloadPath} to ${modelDir}`);
        const directory = await unzipper.Open.file(downloadPath);
        await directory.extract({ path: modelDir });
        logger.info(`Unzipped to ${modelDir}`);
        sender.send("echogarden-download-coreml-model-progress", {
          received: total,
          total,
          state: "completed",
        });

        return;
      } catch (err) {
        lastError = err;
        logger.warn(`Failed to download Core ML model from ${url}`, err);
      }
    }

    throw lastError || new Error("Failed to download Core ML model");
  }
}

export default new EchogardenWrapper();
