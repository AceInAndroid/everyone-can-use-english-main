import { useContext } from "react";
import { AppSettingsProviderContext } from "@renderer/context";
import { TransformersScoringService } from "@renderer/services/TransformersScoringService";

type CreateAssessmentParams = {
  recording: RecordingType;
  reference?: string;
  language?: string;
  targetId?: string;
  targetType?: string;
  onProgress?: (data: any) => void;
};

export const usePronunciationAssessments = () => {
  const { EnjoyApp } = useContext(AppSettingsProviderContext);

  const resolveAudioBlob = async (audioUrl: string): Promise<Blob> => {
    if (!audioUrl) {
      throw new Error("Recording has no audio source");
    }

    const response = await fetch(audioUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch audio (${response.status} ${response.statusText})`
      );
    }
    return await response.blob();
  };

  const createAssessment = async (params: CreateAssessmentParams) => {
    const { recording, onProgress } = params;
    if (!recording) throw new Error("Recording required");

    const reference = params.reference || recording.referenceText || "";
    const language = params.language || recording.language;
    const targetId = params.targetId || recording.id;
    const targetType = params.targetType || "Recording";

    let audioUrl = recording.src;
    try {
      const processed = await EnjoyApp.audioProcessor?.process(recording.src);
      if (processed?.clean) audioUrl = processed.clean;
    } catch {
      // ignore processing failures and fall back to original src
    }

    const blob = await resolveAudioBlob(audioUrl);

    const service = TransformersScoringService.getInstance();
    await service.init(onProgress);
    const result = await service.score(blob, reference);

    console.log("📊 Calculated Scores:", result);

    const assessmentPayload = {
      targetId,
      targetType,
      pronunciationScore: result.score,
      accuracyScore: result.accuracy,
      completenessScore: result.completeness,
      fluencyScore: result.fluency,
      prosodyScore: Math.round((result.fluency + result.accuracy) / 2),
      grammarScore: 0,
      vocabularyScore: 0,
      topicScore: 0,
      result: {
        engine: "transformers_js",
        recognizedText: result.recognizedText,
        referenceText: result.referenceText,
        score: result.score,
      },
      language,
    };

    if (EnjoyApp?.pronunciationAssessments?.create) {
      return EnjoyApp.pronunciationAssessments.create(assessmentPayload);
    }
    return assessmentPayload;
  };

  return { createAssessment };
};
