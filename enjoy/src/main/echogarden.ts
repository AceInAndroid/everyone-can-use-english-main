import { app, ipcMain } from "electron";
import { execSync } from "child_process";
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

        // Call the original recognize function
        Echogarden.recognize(sampleFile, options)
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
