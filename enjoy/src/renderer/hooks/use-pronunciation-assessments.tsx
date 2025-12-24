import { useContext } from "react";
import { AppSettingsProviderContext } from "@renderer/context";
import { TransformersScoringService } from "@renderer/services/TransformersScoringService";

type CreateAssessmentParams = {
  recording: RecordingType;
  reference?: string;
  language?: string;
  targetId?: string;
  targetType?: string;
  onProgress?: (data: { status: string; progress?: number; loaded?: number; total?: number }) => void;
};

/**
 * New pronunciation assessment hook using frontend Transformers scoring.
 */
export const usePronunciationAssessments = () => {
  const { EnjoyApp } = useContext(AppSettingsProviderContext);

  const createAssessment = async (params: CreateAssessmentParams) => {
    const { recording, onProgress } = params;

    if (!recording) throw new Error("Recording is required for assessment");

    // 1. 准备 Reference Text
    const reference = (params.reference || recording.referenceText || "").trim();
    if (!reference) {
      throw new Error("Reference text is missing. Cannot score silence.");
    }

    const language = params.language || recording.language;
    const targetId = params.targetId || recording.id;
    const targetType = params.targetType || "Recording";

    // 2. 获取音频 (尝试获取降噪后的版本，失败则用原版)
    let audioUrl = recording.src;
    try {
      // 确保 backend 返回的是 enjoy:// 协议的 URL，而不是文件路径
      const processed = await EnjoyApp.audioProcessor?.process(recording.src);
      if (processed?.clean) {
        audioUrl = processed.clean;
      }
    } catch (err) {
      console.warn("Audio processing failed, falling back to original:", err);
      // fallback to original recording.src
    }

    // 3. 将 URL 转换为 Blob (Fetch)
    // 注意：这里依赖 enjoy:// 协议被 Electron 正确注册为特权协议
    const resp = await fetch(audioUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch audio from ${audioUrl}: ${resp.statusText}`);
    }
    const blob = await resp.blob();

    // 4. 运行前端评分 (AI Inference)
    const service = TransformersScoringService.getInstance();
    await service.init(onProgress);
    
    // 开始评分
    const result = await service.score(blob, reference);

    // 5. 构造数据库存储对象
    // 目前 Transformers 方案只给出一个整体分 (result.score)
    // 为了兼容旧的数据结构，我们将这个分数填充到所有细分维度
    const assessmentPayload = {
      targetId,
      targetType,
      pronunciationScore: result.score,
      accuracyScore: result.score,    // 暂用整体分代替
      completenessScore: result.score, // 暂用整体分代替
      fluencyScore: result.score,     // 暂用整体分代替
      prosodyScore: result.score,     // 暂用整体分代替
      grammarScore: 0,
      vocabularyScore: 0,
      topicScore: 0,
      result: {
        recognizedText: result.recognizedText,
        referenceText: result.referenceText,
        score: result.score,
        // 如果 service 返回了 word chunks，可以在这里存入，用于后续的高亮显示
        // chunks: result.chunks 
      },
      language,
    };

    // 6. 持久化到数据库
    if (EnjoyApp?.pronunciationAssessments?.create) {
      return EnjoyApp.pronunciationAssessments.create(assessmentPayload);
    }

    return assessmentPayload;
  };

  return { createAssessment };
};
