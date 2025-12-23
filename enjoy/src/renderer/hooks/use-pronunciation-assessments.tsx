import { useContext } from "react";
import { AppSettingsProviderContext } from "@renderer/context";
import { TransformersScoringService } from "@renderer/services/TransformersScoringService";
import path from "path";
import fs from "fs/promises";

type CreateAssessmentParams = {
  recording: RecordingType;
  reference?: string;
  language?: string;
  targetId?: string;
  targetType?: string;
  onProgress?: (data: any) => void;
};

/**
 * New pronunciation assessment hook using frontend Transformers scoring.
 */
export const usePronunciationAssessments = () => {
  const { EnjoyApp, libraryPath } = useContext(AppSettingsProviderContext);

  const resolveAudioBlob = async (audioUrl: string): Promise<Blob> => {
    if (audioUrl.startsWith("enjoy://library/") && libraryPath) {
      const relative = audioUrl.replace("enjoy://library/", "");
      const filePath = path.join(libraryPath, relative);
      const buf = await fs.readFile(filePath);
      return new Blob([buf]);
    }
    const resp = await fetch(audioUrl);
    if (!resp.ok) {
      throw new Error(`Failed to fetch audio: ${resp.statusText}`);
    }
    return await resp.blob();
  };

  const createAssessment = async (params: CreateAssessmentParams) => {
    const { recording, onProgress } = params;
    if (!recording) throw new Error("Recording is required for assessment");

    let reference = params.reference || recording.referenceText || "";
    const language = params.language || recording.language;
    const targetId = params.targetId || recording.id;
    const targetType = params.targetType || "Recording";

    // Fetch audio blob (processed/clean if available)
    let audioUrl = recording.src;
    try {
      const processed = await EnjoyApp.audioProcessor?.process(recording.src);
      audioUrl = processed?.clean || recording.src;
    } catch {
      // fallback to original recording.src
    }
    const blob = await resolveAudioBlob(audioUrl);

    // Run frontend scoring
    const service = TransformersScoringService.getInstance();
    await service.init(onProgress);
    const result = await service.score(blob, reference);

    const resultPayload = {
      recognizedText: result.recognizedText || "",
      referenceText: result.referenceText || "",
      score: Number(result.score) || 0,
    };

    const assessmentPayload: any = {
      targetId,
      targetType,
      pronunciationScore: resultPayload.score,
      accuracyScore: resultPayload.score,
      completenessScore: resultPayload.score,
      fluencyScore: resultPayload.score,
      prosodyScore: resultPayload.score,
      grammarScore: 0,
      vocabularyScore: 0,
      topicScore: 0,
      result: {
        engine: "transformers_js",
        ...resultPayload,
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
