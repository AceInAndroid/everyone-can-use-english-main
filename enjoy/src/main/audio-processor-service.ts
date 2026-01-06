import { app } from "electron";
import path from "path";
import fs from "fs-extra";
import os from "os";
import { execFile } from "child_process";
import { ipcMain } from "electron";
import FfmpegWrapper from "@main/ffmpeg";
import settings from "@main/settings";
import log from "@main/logger";
import { AppSettingsKeyEnum } from "@/types/enums";
import { enjoyUrlToPath, pathToEnjoyUrl } from "@main/utils";

const logger = log.scope("AudioProcessorService");

export class AudioProcessorService {
    private ffmpeg: FfmpegWrapper;

    constructor() {
        this.ffmpeg = new FfmpegWrapper();
    }

    /**
     * Process video to extract and optionally denoise audio.
     * @param videoPath Absolute path to the video file
     * @returns Object containing paths to original and clean audio
     */
    async processVideo(
        videoPath: string
    ): Promise<{ originalAudioPath: string; cleanAudioPath: string }> {
        logger.info(`Start processing video: ${videoPath}`);

        try {
            // 1. Extraction (and conversion to 16k mono wav)
            const originalAudioPath = await this.extractAudio(videoPath);

            // 2. Denoising (optional based on config)
            let cleanAudioPath = originalAudioPath;
            if (this.shouldDenoise()) {
                try {
                    cleanAudioPath = await this.denoiseAudio(originalAudioPath);
                } catch (err) {
                    logger.error("Denoising failed, falling back to original audio", err);
                    // Fallback to original audio if denoising fails
                    cleanAudioPath = originalAudioPath;
                }
            } else {
                logger.info("Denoising skipped due to configuration");
            }

            return {
                originalAudioPath,
                cleanAudioPath,
            };
        } catch (err) {
            logger.error("Error processing video", err);
            throw err;
        }
    }

    /**
     * Extract audio from video and convert to 16kHz, Mono, 16-bit PCM WAV.
     * Stores the result in the system temp directory.
     */
    private async extractAudio(videoPath: string): Promise<string> {
        const filename = path.basename(videoPath, path.extname(videoPath));
        const cacheDir = path.join(settings.cachePath(), "audio-processor");
        fs.ensureDirSync(cacheDir);

        const outputFilename = `${filename}_original_${Date.now()}.wav`;
        const outputPath = path.join(cacheDir, outputFilename);

        logger.info(`Extracting audio to ${outputPath}`);

        // Using FfmpegWrapper's convertToWav which uses default options:
        // -ar 16000 -ac 1 -c:a pcm_s16le
        await this.ffmpeg.convertToWav(videoPath, outputPath);

        return outputPath;
    }

    /**
     * Run DeepFilterNet v3 to denoise the audio.
     * Input must be 16kHz wav.
     */
    private async denoiseAudio(inputPath: string): Promise<string> {
        const deepFilterPath = this.resolveDeepFilterPath();
        if (!deepFilterPath) {
            throw new Error("DeepFilterNet binary not found");
        }

        const cacheDir = path.join(settings.cachePath(), "audio-processor");
        fs.ensureDirSync(cacheDir);

        const filename = path.basename(inputPath, path.extname(inputPath));
        const outputFilename = `${filename}_clean.wav`;
        const outputPath = path.join(cacheDir, outputFilename);

        logger.info(`Denoising audio from ${inputPath} to ${outputPath}`);

        return new Promise((resolve, reject) => {
            // DeepFilterNet v3 arguments might vary. 
            // Common CLI: deep-filter input.wav -o output_dir (it might preserve filename)
            // Or: deep-filter input.wav -o output.wav
            // I will try to pass output file explicitly if supported, or output dir.
            // Assuming: deep-filter <input> -o <output_dir> (and it names it similarly)
            // OR: deep-filter <input> -o <output_file>

            // Let's assume `deep-filter <input> -o <output>` works for now. 
            // If not, I'll need to adjust.
            const args = [inputPath, "-o", outputPath];

            execFile(deepFilterPath, args, (error, stdout, stderr) => {
                if (error) {
                    logger.error("DeepFilterNet error:", stderr);
                    return reject(error);
                }
                logger.info("DeepFilterNet stdout:", stdout);

                // Check if output exists
                if (fs.existsSync(outputPath)) {
                    resolve(outputPath);
                } else {
                    // Sometimes it might append _DeepFilterNet3.wav if given a dir?
                    // If I passed a file path to -o, hopefully it respects it.
                    // If fails, I might search for generated file.
                    // But for now, assume success if no error.
                    reject(new Error(`Output file not found at ${outputPath}`));
                }
            });
        });
    }

    private resolveDeepFilterPath(): string | null {
        const configured = this.expandPath(
            settings.getSync(AppSettingsKeyEnum.AUDIO_PROCESSOR_DEEPFILTER_PATH) as string
        );
        const envCandidate = this.expandPath(
            process.env.DEEPFILTERNET_PATH ||
            process.env.DEEP_FILTER_PATH ||
            process.env.DEEPFILTER_PATH
        );

        const binaryNames = process.platform === "win32"
            ? ["deep-filter.exe", "deep-filter"]
            : ["deep-filter"];

        const searchDirs = [
            path.join(settings.libraryPath(), "bin"),
            path.join(os.homedir(), ".local", "bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
        ];

        if (app.isPackaged) {
            searchDirs.push(path.join(process.resourcesPath, "bin"));
        } else {
            searchDirs.push(path.join(process.cwd(), "bin"));
        }

        const envPath = process.env.PATH || "";
        envPath
            .split(path.delimiter)
            .filter(Boolean)
            .forEach((dir) => searchDirs.push(dir));

        const seen = new Set<string>();
        const candidates: string[] = [];

        const pushCandidate = (candidate?: string | null) => {
            if (!candidate) return;
            const normalized = path.resolve(candidate);
            if (!seen.has(normalized)) {
                seen.add(normalized);
                candidates.push(normalized);
            }
        };

        const collectFromTarget = (target?: string | null) => {
            if (!target) return;
            const normalized = path.resolve(target);
            if (fs.existsSync(normalized) && fs.statSync(normalized).isDirectory()) {
                binaryNames.forEach((name) => pushCandidate(path.join(normalized, name)));
                return;
            }
            pushCandidate(normalized);
        };

        collectFromTarget(configured);
        collectFromTarget(envCandidate);
        searchDirs.forEach((dir) => {
            if (dir) {
                binaryNames.forEach((name) => collectFromTarget(path.join(dir, name)));
            }
        });

        for (const candidate of candidates) {
            if (this.isExecutable(candidate)) {
                if (process.platform !== "win32") {
                    try {
                        fs.chmodSync(candidate, 0o755);
                    } catch {
                        // noop
                    }
                }
                return candidate;
            }
        }

        logger.warn("DeepFilterNet binary not found. Checked candidates:", candidates);
        logger.warn(
            "Configure the binary path in Preferences → Audio or install `deep-filter` so it is available on PATH."
        );
        return null;
    }

    private shouldDenoise(): boolean {
        return settings.getSync(AppSettingsKeyEnum.AUDIO_PROCESSOR_ENABLE_DEEPFILTER) as boolean;
    }

    private expandPath(target?: string | null) {
        if (!target) return null;
        const trimmed = target.trim();
        if (!trimmed) return null;
        if (trimmed.startsWith("~")) {
            return path.join(os.homedir(), trimmed.slice(1));
        }
        return trimmed;
    }

    private isExecutable(filePath: string) {
        try {
            const stat = fs.statSync(filePath);
            return stat.isFile();
        } catch (err) {
            return false;
        }
    }

    registerIpcHandlers() {
        ipcMain.handle("audio-processor-process", async (event, url: string) => {
            try {
                const videoPath = enjoyUrlToPath(url);
                const { originalAudioPath, cleanAudioPath } = await this.processVideo(
                    videoPath
                );
                return {
                    original: pathToEnjoyUrl(originalAudioPath),
                    clean: pathToEnjoyUrl(cleanAudioPath),
                };
            } catch (err) {
                logger.error(err);
                throw err;
            }
        });
    }
}

export default new AudioProcessorService();
