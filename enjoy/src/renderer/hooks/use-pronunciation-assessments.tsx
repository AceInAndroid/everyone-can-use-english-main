import { useContext } from "react";
import { AppSettingsProviderContext } from "@renderer/context";
import { TransformersScoringService } from "@renderer/services/TransformersScoringService";

// 定义入参类型
type CreateAssessmentParams = {
  recording: RecordingType;
  reference?: string;
  language?: string;
  targetId?: string;
  targetType?: string;
  onProgress?: (data: { status: string; progress?: number; loaded?: number; total?: number }) => void;
};

// 定义数据库 Payload 类型
interface AssessmentPayload {
  targetId: string;
  targetType: string;
  pronunciationScore: number;
  accuracyScore: number;
  completenessScore: number;
  fluencyScore: number;
  prosodyScore: number;
  grammarScore: number;
  vocabularyScore: number;
  topicScore: number;
  result: {
    engine: string;
    recognizedText: string;
    referenceText: string;
    score: number;
  };
  language: string;
}

export const usePronunciationAssessments = () => {
  const { EnjoyApp } = useContext(AppSettingsProviderContext);

  /**
   * 辅助函数：安全地获取音频 Blob
   */
  const resolveAudioBlob = async (audioUrl: string): Promise<Blob> => {
    if (!audioUrl) {
      throw new Error("Recording has no audio source");
    }

    // 如果是绝对路径，可能需要 Electron 的自定义协议来访问
    // 假设后端已经返回了 enjoy:// 协议的 URL，这里直接 fetch 是安全的
    console.log(`[Assessment] Fetching audio: ${audioUrl}`);

    const response = await fetch(audioUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch audio (${response.status} ${response.statusText})`);
    }
    return await response.blob();
  };

  /**
   * 核心方法：创建评分
   */
  const createAssessment = async (params: CreateAssessmentParams) => {
    const { recording, onProgress } = params;

    if (!recording) throw new Error("Recording is required for assessment");

    // 1. 准备参数
    const reference = (params.reference || recording.referenceText || "").trim();
    const language = params.language || recording.language || "en-US";
    const targetId = params.targetId || recording.id;
    const targetType = params.targetType || "Recording";

    // 2. 获取音频 URL (尝试降噪)
    let audioUrl = recording.src;
    try {
      // 确保后端返回的是 enjoy:// 协议的 URL
      const processed = await EnjoyApp.audioProcessor?.process(recording.src);
      if (processed?.clean) {
        audioUrl = processed.clean;
      }
    } catch (err) {
      console.warn("Audio processing failed, using original:", err);
    }

    // 3. 获取 Blob
    const blob = await resolveAudioBlob(audioUrl);

    // 4. 调用前端 AI 服务
    const service = TransformersScoringService.getInstance();
    await service.init(onProgress);

    // 获取多维度评分结果
    const result = await service.score(blob, reference);

    // 5. 构造数据库 Payload
    const assessmentPayload: AssessmentPayload = {
      targetId,
      targetType,

      // ✅ 关键修复：分别映射不同的分数字段
      pronunciationScore: result.score,        // 总分
      accuracyScore: result.accuracy,          // 准确度
      completenessScore: result.completeness,  // 完整度
      fluencyScore: result.fluency,            // 流利度

      // 韵律分 (模拟值：取流利度和准确度的平均)
      prosodyScore: Math.round((result.fluency + result.accuracy) / 2),

      grammarScore: 0,
      vocabularyScore: 0,
      topicScore: 0,

      // 结果详情 JSON
      result: {
        engine: "transformers_js",
        recognizedText: result.recognizedText || "",
        referenceText: result.referenceText || "",
        score: result.score,
      },

      language,
    };

    // 6. 存入数据库
    if (EnjoyApp?.pronunciationAssessments?.create) {
      return EnjoyApp.pronunciationAssessments.create(assessmentPayload);
    }

    return assessmentPayload;
  };

  return { createAssessment };
};
