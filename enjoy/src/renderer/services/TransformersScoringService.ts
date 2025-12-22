import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  env,
} from "@xenova/transformers";
import { distance as levenshteinDistance } from "fastest-levenshtein";

// Force browser behavior in Electron renderer: disable local FS lookups.
env.allowLocalModels = false;
env.useBrowserCache = true;

export type ScoreResult = {
  score: number;
  recognizedText: string;
  referenceText: string;
};

export type ProgressCallback = (data: {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}) => void;

/**
 * Pure front-end pronunciation scoring using Xenova wav2vec2.
 * Singleton, no Node APIs.
 */
export class TransformersScoringService {
  private static instance: TransformersScoringService;
  private asrPipeline: AutomaticSpeechRecognitionPipeline | null = null;
  private loadingPromise: Promise<void> | null = null;

  // Dev: base (fast). Prod: switch to large for better accuracy.
  private readonly modelName = "Xenova/wav2vec2-base-960h";
  // private readonly modelName = "Xenova/wav2vec2-large-960h-lv60-self";

  private constructor() {}

  static getInstance() {
    if (!TransformersScoringService.instance) {
      TransformersScoringService.instance = new TransformersScoringService();
    }
    return TransformersScoringService.instance;
  }

  async init(onProgress?: ProgressCallback) {
    if (this.asrPipeline) return;
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    const device =
      typeof navigator !== "undefined" && (navigator as any).gpu
        ? "webgpu"
        : "wasm";

    this.loadingPromise = pipeline("automatic-speech-recognition", this.modelName, {
      device,
      progress_callback: (data: any) => {
        onProgress?.(data);
      },
    })
      .then((asr) => {
        this.asrPipeline = asr as AutomaticSpeechRecognitionPipeline;
      })
      .catch((err) => {
        this.loadingPromise = null;
        throw err;
      });

    await this.loadingPromise;
  }

  async score(audioBlob: Blob, referenceText: string): Promise<ScoreResult> {
    await this.init();

    if (!this.asrPipeline) {
      throw new Error("ASR pipeline not ready");
    }

    const audioUrl = URL.createObjectURL(audioBlob);

    try {
      const output = await this.asrPipeline(audioUrl, {
        return_timestamps: "word",
        chunk_length_s: 30,
      });

      const recognizedText = (output?.text ?? "").trim();

      const normalizedReference = normalize(referenceText);
      const normalizedRecognized = normalize(recognizedText);

      let score = 0;
      if (normalizedReference.length === 0 && normalizedRecognized.length === 0) {
        score = 100;
      } else {
        const distance = levenshteinDistance(
          normalizedReference,
          normalizedRecognized
        );
        const maxLength = Math.max(
          normalizedReference.length,
          normalizedRecognized.length,
          1
        );
        score = Math.max(0, Math.round((1 - distance / maxLength) * 100));
      }

      return { score, recognizedText, referenceText };
    } finally {
      URL.revokeObjectURL(audioUrl);
    }
  }
}

// --- helpers ---

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
