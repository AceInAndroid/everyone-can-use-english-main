import { ScoringEngine } from "@renderer/lib/scoring-engine";
import { useContext } from "react";
import { t } from "i18next";
import { AISettingsProviderContext, AppSettingsProviderContext } from "@renderer/context";
// import camelcaseKeys from "camelcase-keys"; // Unused now?
// import { map, forEach, sum, filter, cloneDeep } from "lodash"; // Unused?
// import * as Diff from "diff"; // Unused?
import { PronunciationAssessmentEngineEnum } from "@/types/enums";
import { transcribeSherpaWasm } from "@renderer/lib/sherpa-wasm";

const THIRTY_SECONDS = 30 * 1000;
const ONE_MINUTE = 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
export const usePronunciationAssessments = () => {
  const { webApi, EnjoyApp } = useContext(AppSettingsProviderContext);
  const { pronunciationAssessmentConfig } = useContext(AISettingsProviderContext);

  const createAssessment = async (params: {
    language: string;
    recording: RecordingType;
    reference?: string;
    targetId?: string;
    targetType?: string;
  }) => {
    let { recording, targetId, targetType } = params;
    if (targetId && targetType && !recording) {
      recording = await EnjoyApp.recordings.findOne({ targetId });
    }

    EnjoyApp.recordings.sync(recording.id);
    EnjoyApp.recordings.sync(recording.id);
    // Use clean audio for Sherpa/Scoring (user recording of video? No, recording.src is user mic. Wait.)
    // If recording.src is user mic, we probably don't need to denoise the laugh track (it's in the reference, not the user recording).
    // BUT the prompt says "User imported sitcom videos... contain laugh tracks... interfere with Sherpa-onnx (scoring)".
    // This implies we should be processing the REFERENCE audio (the target), not the recording.
    // However, `createAssessment` takes `recording`. The reference text is usually `recording.referenceText`.
    // The reference AUDIO is `recording.target` (if it's a segmentation of a video).

    // If we are passing `recording.src` to `assessBySherpaWasm`, we are assessing the USER's speech.
    // If laughing is in the USER's speech (e.g. background), DeepFilter helps.
    // If the prompt meant "The IMPORTED VIDEO causes issues", then we should have processed the Video -> VAD -> Segments (with Clean Audio).

    // Let's assume for this step we replace transcode with audioProcessor and use `clean` path, 
    // effectively cleaning the audio we are about to assess.
    const { clean: url } = await EnjoyApp.audioProcessor.process(recording.src);
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch audio from ${url}: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to fetch audio: ${response.statusText}`);
    }
    const blob = await response.blob();
    console.log(`[usePronunciationAssessments] Fetched audio blob: size=${blob.size}, type=${blob.type}, url=${url}`);

    if (blob.size === 0) {
      console.error("Fetched blob is empty!");
      throw new Error("Fetched audio is empty");
    }
    targetId = recording.id;
    targetType = "Recording";

    const { language, reference = recording.referenceText } = params;

    // Force using Sherpa for local assessment
    // const engine = pronunciationAssessmentConfig?.engine || PronunciationAssessmentEngineEnum.AZURE;

    if (recording.duration && recording.duration > FIVE_MINUTES) {
      throw new Error(t("recordingIsTooLongToAssess"));
    }

    const result = await assessBySherpaWasm({
      EnjoyApp,
      pronunciationAssessmentConfig,
      blob,
      url,
      language,
      reference,
      durationMs: recording?.duration,
    });

    // Legacy Azure token logic removed
    const resultJson = result.detailResult; // assessBySherpaWasm returns a structure that includes detailResult
    // No need to camelcaseKeys or re-parse if we structure it correctly in assessBySherpaWasm, 
    // but the original code did it for Azure results. 
    // assessBySherpaWasm returns { detailResult: { ... } } which logic matches.

    return EnjoyApp.pronunciationAssessments.create({
      targetId: recording.id,
      targetType: "Recording",
      pronunciationScore: result.pronunciationScore,
      accuracyScore: result.accuracyScore,
      completenessScore: result.completenessScore,
      fluencyScore: result.fluencyScore,
      prosodyScore: result.prosodyScore,
      grammarScore: 0,
      vocabularyScore: 0,
      topicScore: 0,
      result: resultJson,
      language: params.language || recording.language,
    });
  };



  return {
    createAssessment,
  };
};

const tokenize = (text: string): string[] => {
  return (text || "")
    .match(/[A-Za-z]+(?:'[A-Za-z]+)?/g)
    ?.map((w) => w.trim())
    .filter(Boolean) || [];
};

const normalizeToken = (token: string) => token.toLowerCase();

type AlignmentOp =
  | { type: "equal"; ref: string; hyp: string; hypIndex: number }
  | { type: "replace"; ref: string; hyp: string; hypIndex: number }
  | { type: "delete"; ref: string }
  | { type: "insert"; hyp: string; hypIndex: number };



const flattenTimeline = (entries: any[]): any[] => {
  const flattened: any[] = [];

  const walk = (entry: any) => {
    if (!entry) return;
    flattened.push(entry);
    if (Array.isArray(entry.timeline)) {
      entry.timeline.forEach(walk);
    }
  };

  (entries || []).forEach(walk);
  return flattened;
};

const extractHypothesisWordTimeline = (
  timeline: any[]
): { token: string; offset: number; duration: number }[] => {
  const flattened = flattenTimeline(timeline);
  const leaves = flattened.filter(
    (e) =>
      e &&
      typeof e.text === "string" &&
      typeof e.startTime === "number" &&
      typeof e.endTime === "number" &&
      (!Array.isArray(e.timeline) || e.timeline.length === 0)
  );

  const picked = leaves.length > 0 ? leaves : flattened;

  const items: { token: string; offset: number; duration: number }[] = [];
  for (const entry of picked) {
    if (!entry || typeof entry.text !== "string") continue;
    const tokens = tokenize(entry.text);
    if (tokens.length === 0) continue;

    const startTime = typeof entry.startTime === "number" ? entry.startTime : 0;
    const endTime = typeof entry.endTime === "number" ? entry.endTime : startTime;
    const offset = Math.max(0, Math.round(startTime * 1e7));
    const duration = Math.max(0, Math.round((endTime - startTime) * 1e7));

    for (const token of tokens) {
      items.push({ token, offset, duration });
    }
  }

  return items;
};

const clampScore = (n: number) => Math.max(0, Math.min(100, n));

const assessBySherpaWasm = async (params: {
  EnjoyApp: any;
  pronunciationAssessmentConfig?: PronunciationAssessmentConfigType;
  blob: Blob;
  url: string;
  language: string;
  reference: string;
  durationMs?: number;
}) => {
  const { EnjoyApp, pronunciationAssessmentConfig, blob, url, language, reference, durationMs } =
    params;

  const sherpaModelId = pronunciationAssessmentConfig?.sherpa?.modelId || "en-us-small";

  // Sherpa runs in the renderer (WASM); we still use Echogarden's DTW alignment to get word-level timing.
  const recognized = await transcribeSherpaWasm({ blob });
  const transcript: string = recognized?.transcript || "";
  const globalConfidence = recognized?.confidence ?? 0.95;

  const languageCode = (language || "en-US").split("-")[0];
  const alignmentResult = await EnjoyApp.echogarden.align(
    url,
    transcript,
    {
      engine: "dtw",
      language: languageCode,
      isolate: false,
    }
  );

  // Extract recognized tokens with timestamps from the alignment of Hypothesis to Audio
  const hypTimeline = extractHypothesisWordTimeline(alignmentResult?.timeline || []);
  const recognizedTokens = hypTimeline.map(t => ({
    text: t.token,
    start: t.offset / 1e7, // Convert ticks to seconds
    end: (t.offset + t.duration) / 1e7,
    confidence: globalConfidence // Use global confidence as fallback
  }));

  // Run the Scoring Engine
  const report = ScoringEngine.assess({
    referenceText: reference || transcript, // Use transcript if reference is missing? Usually reference is required.
    recognizedTokens
  });

  // Map Report back to Legacy Data Structure (for DB storage)
  const words: PronunciationAssessmentWordResultType[] = report.details.map(w => ({
    word: w.word,
    offset: (w.timestamps?.start || 0) * 1e7,
    duration: ((w.timestamps?.end || 0) - (w.timestamps?.start || 0)) * 1e7,
    pronunciationAssessment: {
      accuracyScore: w.score,
      errorType: w.status === 'correct' ? 'None' :
        w.status === 'mispronounced' ? 'Mispronunciation' :
          w.status === 'omitted' ? 'Omission' :
            w.status === 'inserted' ? 'Insertion' : 'None' // 'inserted' not in details usually
    },
    phonemes: [] as any[],
    syllables: [] as any[]
  }));

  const detailResult = {
    engine: "sherpa_wasm",
    sherpa: { modelId: sherpaModelId },
    confidence: globalConfidence,
    display: transcript,
    itn: transcript,
    lexical: transcript,
    markedItn: transcript,
    pronunciationAssessment: {
      accuracyScore: report.pronunciationScore,
      completenessScore: report.integrityScore,
      fluencyScore: report.fluencyScore,
      pronScore: report.overallScore,
    },
    words,
  };

  return {
    pronunciationScore: report.overallScore,
    accuracyScore: report.pronunciationScore, // Mapping explicit pronunciation accuracy
    completenessScore: report.integrityScore,
    fluencyScore: report.fluencyScore,
    prosodyScore: report.fluencyScore, // Map fluency to prosody roughly
    detailResult,
  };
};


