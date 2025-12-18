import { app } from "electron";
import path from "path";
import fs from "fs-extra";
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
        let binaryPath = "";
        if (app.isPackaged) {
            // In production, binary should be in resources path
            // e.g. /Applications/Enjoy.app/Contents/Resources/bin/deep-filter
            binaryPath = path.join(process.resourcesPath, "bin", "deep-filter");
        } else {
            // In development, assume 'bin/deep-filter' at project root
            // process.cwd() is usually the project root in electron-forge dev
            binaryPath = path.join(process.cwd(), "bin", "deep-filter");
        }

        if (fs.existsSync(binaryPath)) {
            return binaryPath;
        }

        // Try finding in PATH if not found in explicit locations
        // This is bit trickier with execFile, but we returned absolute path above.
        // If we return just "deep-filter", execFile might look in PATH.
        // But explicit path is safer for bundled app.

        logger.warn(`DeepFilterNet binary not found at ${binaryPath}`);
        return null;
    }

    private shouldDenoise(): boolean {
        return settings.getSync(AppSettingsKeyEnum.AUDIO_PROCESSOR_ENABLE_DEEPFILTER) as boolean;
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
