import { pipeline, type AutomaticSpeechRecognitionPipeline, env } from "@xenova/transformers";
import { distance as levenshteinDistance } from "fastest-levenshtein";

// Enable browser cache so model stays cached across sessions.
env.useBrowserCache = true;

export type ScoringResult = {
  referenceText: string;
  recognizedText: string;
  normalizedReference: string;
  normalizedRecognized: string;
  score: number; // 0 - 100
  chunks?: Array<{ text: string; timestamp: [number, number] }>;
};

export type AlignmentResult = {
  text: string;
  chunks?: Array<{ text: string; timestamp: [number, number] }>;
};

export type ProgressCallback = (data: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => void;

/**
 * TransformersScoringService
 * Lightweight singleton that wraps Xenova's wav2vec2 ASR for pronunciation scoring.
 * Runs fully in the renderer/worker without native Node modules.
 */
export class TransformersScoringService {
  private static instance: TransformersScoringService;

  private asrPipeline: AutomaticSpeechRecognitionPipeline | null = null;
  private loadingPromise: Promise<void> | null = null;

  // Use base model for development speed; swap to large for higher accuracy.
  private modelName = "Xenova/wav2vec2-base-960h";

  static getInstance() {
    if (!TransformersScoringService.instance) {
      TransformersScoringService.instance = new TransformersScoringService();
    }
    return TransformersScoringService.instance;
  }

  /**
   * Lazily load the ASR pipeline. Uses WebGPU when available, otherwise falls back to WASM.
   */
  public async init(onProgress?: ProgressCallback) {
    if (this.asrPipeline) return;
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    const device = typeof navigator !== "undefined" && (navigator as any).gpu ? "webgpu" : "wasm";
    // Example: env.allowLocalModels = false; env.useBrowserCache = true;
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

  /**
   * Run ASR + holistic Levenshtein scoring.
   */
  async score(userAudioBlob: Blob, referenceText: string): Promise<ScoringResult> {
    await this.init();
    if (!this.asrPipeline) throw new Error("ASR pipeline failed to initialize");

    // Convert Blob to URL for stable transformer ingestion.
    const audioUrl = URL.createObjectURL(userAudioBlob);
    try {
      const output = await this.asrPipeline(audioUrl, {
        return_timestamps: "word",
        chunk_length_s: 30,
      });

      const userText = (output?.text ?? "").trim();
      const normalizedReference = normalizeText(referenceText);
      const normalizedRecognized = normalizeText(userText);

      let score = 0;
      if (normalizedReference.length === 0 && normalizedRecognized.length === 0) {
        score = 100;
      } else {
        const distance = levenshteinDistance(normalizedReference, normalizedRecognized);
        const maxLength = Math.max(normalizedReference.length, normalizedRecognized.length, 1);
        score = Math.max(0, Math.round((1 - distance / maxLength) * 100));
      }

      return {
        referenceText,
        recognizedText: userText,
        normalizedReference,
        normalizedRecognized,
        score,
        chunks: Array.isArray((output as any)?.chunks) ? (output as any).chunks : undefined,
      };
    } finally {
      URL.revokeObjectURL(audioUrl);
    }
  }

  /**
   * Directly exposes ASR timestamps for downstream alignment/visualization.
   */
  async align(audioBlob: Blob): Promise<AlignmentResult> {
    await this.init();
    if (!this.asrPipeline) throw new Error("ASR pipeline failed to initialize");

    const audioUrl = URL.createObjectURL(audioBlob);
    try {
      const output = await this.asrPipeline(audioUrl, {
        return_timestamps: "word",
        chunk_length_s: 30,
      });

      return {
        text: output?.text ?? "",
        chunks: Array.isArray((output as any)?.chunks) ? (output as any).chunks : undefined,
      };
    } finally {
      URL.revokeObjectURL(audioUrl);
    }
  }
}

// --- utils ---

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
