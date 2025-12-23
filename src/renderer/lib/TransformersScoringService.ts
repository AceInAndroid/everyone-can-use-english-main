import {
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  env,
} from "@xenova/transformers";
import { distance as levenshteinDistance } from "fastest-levenshtein";

// 🔧 强制配置：禁用本地文件系统查找，强制使用浏览器缓存
// 这对 Electron 渲染进程至关重要，防止它尝试调用 fs.readFile
env.allowLocalModels = false;
env.useBrowserCache = true;

// 1. 定义多维度评分结果类型
export type ScoreResult = {
  score: number;          // 综合总分
  accuracy: number;       // 准确度 (拼写/音素相似度)
  completeness: number;   // 完整度 (长度比例)
  fluency: number;        // 流利度 (基于冗余度惩罚)
  recognizedText: string; // 识别出的文本
  referenceText: string;  // 标准文本
};

export type ProgressCallback = (data: {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}) => void;

/**
 * TransformersScoringService
 * 纯前端语音评分服务，运行在 Electron 渲染进程中。
 * 使用 Wav2Vec2 模型进行 ASR，并基于编辑距离算法计算多维度评分。
 */
export class TransformersScoringService {
  private static instance: TransformersScoringService;
  private asrPipeline: AutomaticSpeechRecognitionPipeline | null = null;
  private loadingPromise: Promise<void> | null = null;

  // 💡 模型选择建议：
  // "base": 下载快 (约 200MB)，适合开发调试
  // "large": 精度高 (约 1.2GB)，适合生产环境
  private readonly modelName = "Xenova/wav2vec2-base-960h";
  // private readonly modelName = "Xenova/wav2vec2-large-960h-lv60-self";

  private constructor() { }

  static getInstance() {
    if (!TransformersScoringService.instance) {
      TransformersScoringService.instance = new TransformersScoringService();
    }
    return TransformersScoringService.instance;
  }

  /**
   * 初始化 Pipeline (懒加载)
   */
  async init(onProgress?: ProgressCallback) {
    if (this.asrPipeline) return;
    if (this.loadingPromise) {
      await this.loadingPromise;
      return;
    }

    // 优先使用 WebGPU 加速 (M1/M2 芯片支持极佳)
    const device =
      typeof navigator !== "undefined" && (navigator as any).gpu
        ? "webgpu"
        : "wasm";

    console.log(`[Transformers] Loading model ${this.modelName} using ${device}...`);

    this.loadingPromise = pipeline("automatic-speech-recognition", this.modelName, {
      device,
      progress_callback: (data: any) => {
        onProgress?.(data);
      },
    })
      .then((asr) => {
        this.asrPipeline = asr as AutomaticSpeechRecognitionPipeline;
        console.log("[Transformers] Model loaded successfully.");
      })
      .catch((err) => {
        console.error("[Transformers] Failed to load model:", err);
        this.loadingPromise = null; // 允许重试
        throw err;
      });

    await this.loadingPromise;
  }

  /**
   * 核心评分方法
   */
  async score(audioBlob: Blob, referenceText: string): Promise<ScoreResult> {
    await this.init();

    if (!this.asrPipeline) {
      throw new Error("ASR pipeline not ready");
    }

    // 将 Blob 转为 URL 供 pipeline 使用
    const audioUrl = URL.createObjectURL(audioBlob);

    try {
      // 1. 执行 ASR 识别
      const output = await this.asrPipeline(audioUrl, {
        return_timestamps: "word", // 虽然这里暂未用到时间戳，但保留配置以便未来扩展
        chunk_length_s: 30,        // 处理长音频
      });

      const recognizedText = (output?.text ?? "").trim();

      // 2. 文本归一化 (转小写，去标点)
      const normRef = normalize(referenceText);
      const normRec = normalize(recognizedText);

      // 3. 计算多维度分数
      let accuracy = 0;
      let completeness = 0;
      let fluency = 0;
      let overallScore = 0;

      // 如果标准文本为空，无法评分
      if (normRef.length === 0) {
        if (normRec.length === 0) overallScore = 100; // 都空则满分
      } else {
        // --- 算法逻辑 ---

        // A. 准确度 (Accuracy): 基于 Levenshtein 编辑距离
        const dist = levenshteinDistance(normRef, normRec);
        const maxLen = Math.max(normRef.length, normRec.length, 1);
        accuracy = Math.max(0, Math.round((1 - dist / maxLen) * 100));

        // B. 完整度 (Completeness): 基于长度比例
        // 读得越完整，长度越接近。如果读少了扣分，读多了不扣分。
        const lengthRatio = Math.min(1, normRec.length / (normRef.length || 1));
        completeness = Math.round(lengthRatio * 100);

        // C. 流利度 (Fluency): 模拟算法
        // 如果识别出的文本比原文长很多，说明有重复、停顿词或噪音
        fluency = accuracy;
        if (normRec.length > normRef.length * 1.3) {
          // 惩罚过度啰嗦
          fluency = Math.max(0, fluency - 15);
        } else {
          // 给予一点奖励分，鼓励自信
          fluency = Math.min(100, fluency + 5);
        }

        // D. 总分 (Weighted Average)
        // 权重：准确度 60%, 完整度 20%, 流利度 20%
        overallScore = Math.round(
          accuracy * 0.6 + completeness * 0.2 + fluency * 0.2
        );
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
      // 4. 清理内存
      URL.revokeObjectURL(audioUrl);
    }
  }
}

// --- 辅助函数 ---

function normalize(text: string): string {
  return text
    .toLowerCase()
    // 移除除字母、数字、空格以外的所有字符 (去标点)
    .replace(/[^a-z0-9\s]/g, "")
    // 将多个连续空格合并为一个 (注意这里是 \s 不是 \\s)
    .replace(/\s+/g, " ")
    .trim();
}
