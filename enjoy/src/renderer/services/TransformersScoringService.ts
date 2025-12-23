import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  env,
} from "@xenova/transformers";
import { distance as levenshteinDistance } from "fastest-levenshtein";

env.allowLocalModels = false;
env.useBrowserCache = true;

// 1. 定义多维度结果类型
export type ScoreResult = {
  score: number;
  accuracy: number;
  completeness: number;
  fluency: number;
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

export class TransformersScoringService {
  private static instance: TransformersScoringService;
  private asrPipeline: AutomaticSpeechRecognitionPipeline | null = null;
  private loadingPromise: Promise<void> | null = null;
  private readonly modelName = "Xenova/wav2vec2-base-960h";

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

    this.loadingPromise = pipeline(
      "automatic-speech-recognition",
      this.modelName,
      {
        device,
        progress_callback: (data: any) => {
          onProgress?.(data);
        },
      }
    )
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
    if (!this.asrPipeline) throw new Error("ASR pipeline not ready");

    const audioUrl = URL.createObjectURL(audioBlob);

    try {
      const output = await this.asrPipeline(audioUrl, {
        return_timestamps: "word",
        chunk_length_s: 30,
      });

      const recognizedText = (output?.text ?? "").trim();
      const normRef = normalize(referenceText);
      const normRec = normalize(recognizedText);

      let accuracy = 0;
      let completeness = 0;
      let fluency = 0;
      let overallScore = 0;

      if (normRef.length > 0 || normRec.length > 0) {
        // --- 核心算法更新 ---

        // 1. 准确度 (基于差异)
        const dist = levenshteinDistance(normRef, normRec);
        const maxLen = Math.max(normRef.length, normRec.length, 1);
        accuracy = Math.max(0, Math.round((1 - dist / maxLen) * 100));

        // 2. 完整度 (基于长度)
        const lengthRatio = Math.min(1, normRec.length / (normRef.length || 1));
        completeness = Math.round(lengthRatio * 100);

        // 3. 流利度 (模拟: 准确度高且不啰嗦则高)
        fluency = accuracy;
        if (normRec.length > normRef.length * 1.2) {
          fluency = Math.max(0, fluency - 10);
        } else {
          fluency = Math.min(100, fluency + 5);
        }

        // 4. 总分
        overallScore = Math.round(
          accuracy * 0.6 + completeness * 0.2 + fluency * 0.2
        );
      } else {
        overallScore = 100;
        accuracy = 100;
        completeness = 100;
        fluency = 100;
      }

      return {
        score: overallScore,
        accuracy,
        completeness,
        fluency,
        recognizedText,
        referenceText,
      };
    } finally {
      URL.revokeObjectURL(audioUrl);
    }
  }
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
