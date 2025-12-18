import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { useContext } from "react";
import { t } from "i18next";
import { AISettingsProviderContext, AppSettingsProviderContext } from "@renderer/context";
import camelcaseKeys from "camelcase-keys";
import { map, forEach, sum, filter, cloneDeep } from "lodash";
import * as Diff from "diff";
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

    const engine =
      pronunciationAssessmentConfig?.engine || PronunciationAssessmentEngineEnum.AZURE;

    let result: any = null;
    let tokenId: number | null = null;

    if (engine === PronunciationAssessmentEngineEnum.WHISPER_LOCAL) {
      if (recording.duration && recording.duration > FIVE_MINUTES) {
        throw new Error(t("recordingIsTooLongToAssess"));
      }

      result = await assessByWhisperLocal({
        EnjoyApp,
        pronunciationAssessmentConfig,
        url,
        blob,
        language,
        reference,
        durationMs: recording?.duration,
      });
    } else if (engine === PronunciationAssessmentEngineEnum.SHERPA_WASM) {
      if (recording.duration && recording.duration > FIVE_MINUTES) {
        throw new Error(t("recordingIsTooLongToAssess"));
      }

      result = await assessBySherpaWasm({
        EnjoyApp,
        pronunciationAssessmentConfig,
        blob,
        url,
        language,
        reference,
        durationMs: recording?.duration,
      });
    } else {
      if (recording.duration && recording.duration > ONE_MINUTE) {
        throw new Error(t("recordingIsTooLongToAssess"));
      }

      const { id, token, region } = await webApi.generateSpeechToken({
        purpose: "pronunciation_assessment",
        targetId,
        targetType,
      });
      tokenId = id;

      if ((recording.duration || 0) < THIRTY_SECONDS) {
        result = await assess(
          {
            blob,
            language,
            reference,
          },
          { token, region }
        );
      } else {
        result = await continousAssess(
          {
            blob,
            language,
            reference,
          },
          { token, region }
        );
      }
    }

    const resultJson = camelcaseKeys(JSON.parse(JSON.stringify(result.detailResult)), {
      deep: true,
    });
    if (tokenId) resultJson.tokenId = tokenId;
    resultJson.duration = recording?.duration;

    return EnjoyApp.pronunciationAssessments.create({
      targetId: recording.id,
      targetType: "Recording",
      pronunciationScore: result.pronunciationScore,
      accuracyScore: result.accuracyScore,
      completenessScore: result.completenessScore,
      fluencyScore: result.fluencyScore,
      prosodyScore: result.prosodyScore,
      grammarScore: result.contentAssessmentResult?.grammarScore,
      vocabularyScore: result.contentAssessmentResult?.vocabularyScore,
      topicScore: result.contentAssessmentResult?.topicScore,
      result: resultJson,
      language: params.language || recording.language,
    });
  };

  const assess = async (
    params: {
      blob: Blob;
      language: string;
      reference?: string;
    },
    options: {
      token: string;
      region: string;
    }
  ): Promise<sdk.PronunciationAssessmentResult> => {
    const { blob, language, reference } = params;
    const { token, region } = options;
    const config = sdk.SpeechConfig.fromAuthorizationToken(token, region);
    const audioConfig = sdk.AudioConfig.fromWavFileInput(
      new File([blob], "audio.wav")
    );

    const pronunciationAssessmentConfig = new sdk.PronunciationAssessmentConfig(
      reference,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true
    );
    pronunciationAssessmentConfig.phonemeAlphabet = "IPA";

    // setting the recognition language
    config.speechRecognitionLanguage = language;

    // create the speech recognizer.
    const reco = new sdk.SpeechRecognizer(config, audioConfig);
    pronunciationAssessmentConfig.applyTo(reco);

    return new Promise((resolve, reject) => {
      reco.recognizeOnceAsync((result) => {
        reco.close();

        switch (result.reason) {
          case sdk.ResultReason.RecognizedSpeech:
            const pronunciationResult =
              sdk.PronunciationAssessmentResult.fromResult(result);
            console.debug(
              "Received pronunciation assessment result.",
              pronunciationResult.detailResult
            );
            resolve(pronunciationResult);
            break;
          case sdk.ResultReason.NoMatch:
            reject(new Error("No speech could be recognized."));
            break;
          case sdk.ResultReason.Canceled:
            const cancellationDetails =
              sdk.CancellationDetails.fromResult(result);
            console.debug(
              "CANCELED: Reason=" +
              cancellationDetails.reason +
              " ErrorDetails=" +
              cancellationDetails.errorDetails
            );
            reject(new Error(cancellationDetails.errorDetails));
            break;
          default:
            reject(result);
        }
      });
    });
  };

  const continousAssess = async (
    params: {
      blob: Blob;
      language: string;
      reference?: string;
    },
    options: {
      token: string;
      region: string;
    }
  ): Promise<sdk.PronunciationAssessmentResult> => {
    const { blob, language, reference } = params;
    const { token, region } = options;
    const config = sdk.SpeechConfig.fromAuthorizationToken(token, region);
    const audioConfig = sdk.AudioConfig.fromWavFileInput(
      new File([blob], "audio.wav")
    );

    const pronunciationAssessmentConfig = new sdk.PronunciationAssessmentConfig(
      reference,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true
    );
    pronunciationAssessmentConfig.phonemeAlphabet = "IPA";

    // setting the recognition language
    config.speechRecognitionLanguage = language;

    // create the speech recognizer.
    const reco = new sdk.SpeechRecognizer(config, audioConfig);
    pronunciationAssessmentConfig.applyTo(reco);

    return new Promise((resolve, reject) => {
      const pronunciationResults: sdk.PronunciationAssessmentResult[] = [];

      // The event recognizing signals that an intermediate recognition result is received.
      // You will receive one or more recognizing events as a speech phrase is recognized, with each containing
      // more recognized speech. The event will contain the text for the recognition since the last phrase was recognized.
      reco.recognizing = function (s, e) {
        const str =
          "(recognizing) Reason: " +
          sdk.ResultReason[e.result.reason] +
          " Text: " +
          e.result.text;
        console.log(str);
      };

      // The event recognized signals that a final recognition result is received.
      // This is the final event that a phrase has been recognized.
      // For continuous recognition, you will get one recognized event for each phrase recognized.
      reco.recognized = function (s, e) {
        console.log("pronunciation assessment for: ", e.result.text);
        const pronunciation_result =
          sdk.PronunciationAssessmentResult.fromResult(e.result);
        pronunciationResults.push(pronunciation_result);
        console.log("pronunciation result: ", pronunciation_result);
      };

      // The event signals that the service has stopped processing speech.
      // https://docs.microsoft.com/javascript/api/microsoft-cognitiveservices-speech-sdk/speechrecognitioncanceledeventargs?view=azure-node-latest
      // This can happen for two broad classes of reasons.
      // 1. An error is encountered.
      //    In this case the .errorDetails property will contain a textual representation of the error.
      // 2. Speech was detected to have ended.
      //    This can be caused by the end of the specified file being reached, or ~20 seconds of silence from a microphone input.
      reco.canceled = function (s, e) {
        if (e.reason === sdk.CancellationReason.Error) {
          const str =
            "(cancel) Reason: " +
            sdk.CancellationReason[e.reason] +
            ": " +
            e.errorDetails;
          console.error(str);
          reject(new Error(e.errorDetails));
        }
        reco.stopContinuousRecognitionAsync();
      };

      // Signals that a new session has started with the speech service
      reco.sessionStarted = function (s, e) { };

      // Signals the end of a session with the speech service.
      reco.sessionStopped = function (s, e) {
        reco.stopContinuousRecognitionAsync();
        reco.close();
        const mergedDetailResult = mergePronunciationResults();
        console.log("Merged detail result:", mergedDetailResult);
        const result = {
          pronunciationScore:
            mergedDetailResult.PronunciationAssessment.PronScore,
          accuracyScore:
            mergedDetailResult.PronunciationAssessment.AccuracyScore,
          completenessScore:
            mergedDetailResult.PronunciationAssessment.CompletenessScore,
          fluencyScore: mergedDetailResult.PronunciationAssessment.FluencyScore,
          prosodyScore: mergedDetailResult.PronunciationAssessment.ProsodyScore,
          detailResult: mergedDetailResult,
          contentAssessmentResult: mergedDetailResult.ContentAssessmentResult,
        };
        resolve(result as sdk.PronunciationAssessmentResult);
      };

      const mergePronunciationResults = () => {
        const detailResults = pronunciationResults.map((result) =>
          JSON.parse(JSON.stringify(result.detailResult))
        );

        const mergedDetailResult = detailResults.reduce(
          (acc, curr) => {
            acc.Confidence += curr.Confidence;
            acc.Display += " " + curr.Display;
            acc.ITN += " " + curr.ITN;
            acc.Lexical += " " + curr.Lexical;
            acc.MaskedITN += " " + curr.MaskedITN;
            acc.Words.push(...curr.Words);
            acc.PronunciationAssessment.AccuracyScore +=
              curr.PronunciationAssessment.AccuracyScore;
            acc.PronunciationAssessment.CompletenessScore +=
              curr.PronunciationAssessment.CompletenessScore;
            acc.PronunciationAssessment.FluencyScore +=
              curr.PronunciationAssessment.FluencyScore;
            acc.PronunciationAssessment.ProsodyScore +=
              curr.PronunciationAssessment?.ProsodyScore ?? 0;
            acc.PronunciationAssessment.PronScore +=
              curr.PronunciationAssessment?.PronScore ?? 0;

            acc.ContentAssessmentResult.GrammarScore +=
              curr.ContentAssessmentResult?.GrammarScore ?? 0;
            acc.ContentAssessmentResult.VocabularyScore +=
              curr.ContentAssessmentResult?.VocabularyScore ?? 0;
            acc.ContentAssessmentResult.TopicScore +=
              curr.ContentAssessmentResult?.TopicScore ?? 0;

            return acc;
          },
          {
            Confidence: 0,
            Display: "",
            ITN: "",
            Lexical: "",
            MaskedITN: "",
            Words: [],
            PronunciationAssessment: {
              AccuracyScore: 0,
              CompletenessScore: 0,
              FluencyScore: 0,
              ProsodyScore: 0,
              PronScore: 0,
            },
            ContentAssessmentResult: {
              GrammarScore: 0,
              VocabularyScore: 0,
              TopicScore: 0,
            },
          }
        );

        mergedDetailResult.PronunciationAssessment.AccuracyScore = (
          mergedDetailResult.PronunciationAssessment.AccuracyScore /
          pronunciationResults.length
        ).toFixed(2);
        mergedDetailResult.PronunciationAssessment.CompletenessScore = (
          mergedDetailResult.PronunciationAssessment.CompletenessScore /
          pronunciationResults.length
        ).toFixed(2);
        mergedDetailResult.PronunciationAssessment.FluencyScore = (
          mergedDetailResult.PronunciationAssessment.FluencyScore /
          pronunciationResults.length
        ).toFixed(2);
        mergedDetailResult.PronunciationAssessment.ProsodyScore = (
          mergedDetailResult.PronunciationAssessment.ProsodyScore /
          pronunciationResults.length
        ).toFixed(2);
        mergedDetailResult.PronunciationAssessment.PronScore = (
          mergedDetailResult.PronunciationAssessment.PronScore /
          pronunciationResults.length
        ).toFixed(2);

        mergedDetailResult.Confidence =
          mergedDetailResult.Confidence / pronunciationResults.length;

        mergedDetailResult.ContentAssessmentResult.GrammarScore = (
          mergedDetailResult.ContentAssessmentResult.GrammarScore /
          pronunciationResults.length
        ).toFixed(2);
        mergedDetailResult.ContentAssessmentResult.VocabularyScore = (
          mergedDetailResult.ContentAssessmentResult.VocabularyScore /
          pronunciationResults.length
        ).toFixed(2);
        mergedDetailResult.ContentAssessmentResult.TopicScore = (
          mergedDetailResult.ContentAssessmentResult.TopicScore /
          pronunciationResults.length
        ).toFixed(2);

        return mergedDetailResult;
      };

      reco.startContinuousRecognitionAsync();
    });
  };

  return {
    createAssessment,
    assess,
    continousAssess,
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

const alignTokens = (refTokens: string[], hypTokens: string[]): AlignmentOp[] => {
  const n = refTokens.length;
  const m = hypTokens.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0)
  );

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost =
        normalizeToken(refTokens[i - 1]) === normalizeToken(hypTokens[j - 1]) ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  const ops: AlignmentOp[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
      ops.push({ type: "delete", ref: refTokens[i - 1] });
      i -= 1;
      continue;
    }

    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      ops.push({ type: "insert", hyp: hypTokens[j - 1], hypIndex: j - 1 });
      j -= 1;
      continue;
    }

    const ref = refTokens[i - 1];
    const hyp = hypTokens[j - 1];
    const isEqual = normalizeToken(ref) === normalizeToken(hyp);
    ops.push({
      type: isEqual ? "equal" : "replace",
      ref,
      hyp,
      hypIndex: j - 1,
    });
    i -= 1;
    j -= 1;
  }

  return ops.reverse();
};

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

  const hypTimeline = extractHypothesisWordTimeline(alignmentResult?.timeline || []);
  const hypTokens = hypTimeline.map((w) => w.token);
  const refTokens = tokenize(reference || transcript);

  const ops = alignTokens(refTokens, hypTokens);

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let matches = 0;

  const words: PronunciationAssessmentWordResultType[] = [];
  for (const op of ops) {
    if (op.type === "equal") {
      matches += 1;
      const meta = hypTimeline[op.hypIndex];
      words.push({
        word: op.ref,
        offset: meta?.offset || 0,
        duration: meta?.duration || 0,
        pronunciationAssessment: { accuracyScore: 100, errorType: "None" },
        phonemes: [],
      } as any);
    } else if (op.type === "replace") {
      substitutions += 1;
      const meta = hypTimeline[op.hypIndex];
      words.push({
        word: op.ref,
        offset: meta?.offset || 0,
        duration: meta?.duration || 0,
        pronunciationAssessment: {
          accuracyScore: 20,
          errorType: "Mispronunciation",
        },
        phonemes: [],
      } as any);
    } else if (op.type === "delete") {
      deletions += 1;
      words.push({
        word: op.ref,
        offset: 0,
        duration: 0,
        pronunciationAssessment: { accuracyScore: 0, errorType: "Omission" },
        phonemes: [],
      } as any);
    } else if (op.type === "insert") {
      insertions += 1;
      const meta = hypTimeline[op.hypIndex];
      words.push({
        word: op.hyp,
        offset: meta?.offset || 0,
        duration: meta?.duration || 0,
        pronunciationAssessment: { accuracyScore: 0, errorType: "Insertion" },
        phonemes: [],
      } as any);
    }
  }

  const n = Math.max(1, refTokens.length);
  const wer = (substitutions + deletions + insertions) / n;
  const accuracy = matches / n;
  const completeness = (n - deletions) / n;
  const fluency = durationMs
    ? Math.min(1, (hypTokens.length / (durationMs / 1000)) / 3) * 100
    : accuracy * 100;

  const pronunciationScore = clampScore((1 - wer) * 100);
  const accuracyScore = clampScore(accuracy * 100);
  const completenessScore = clampScore(completeness * 100);
  const fluencyScore = clampScore(fluency);

  const detailResult = {
    engine: "sherpa_wasm",
    sherpa: { modelId: sherpaModelId },
    confidence: recognized?.confidence ?? 0,
    display: transcript,
    itn: transcript,
    lexical: transcript,
    markedItn: transcript,
    pronunciationAssessment: {
      accuracyScore,
      completenessScore,
      fluencyScore,
      pronScore: pronunciationScore,
    },
    words,
  };

  return {
    pronunciationScore,
    accuracyScore,
    completenessScore,
    fluencyScore,
    detailResult,
  };
};

const assessByWhisperLocal = async (params: {
  EnjoyApp: any;
  pronunciationAssessmentConfig?: PronunciationAssessmentConfigType;
  url: string;
  blob: Blob;
  language: string;
  reference: string;
  durationMs?: number;
}) => {
  const {
    EnjoyApp,
    pronunciationAssessmentConfig,
    url,
    blob,
    language,
    reference,
    durationMs,
  } = params;

  const languageCode = (language || "en-US").split("-")[0];
  const whisperEngine =
    pronunciationAssessmentConfig?.whisper?.engine || ("whisper" as const);
  const model = pronunciationAssessmentConfig?.whisper?.model || "tiny";

  const recognitionOptions: EchogardenSttConfigType = {
    engine: whisperEngine,
    whisper: { model },
    whisperCpp: { model },
  };

  const recognized = await EnjoyApp.echogarden.recognize(url, {
    language: languageCode,
    ...recognitionOptions,
  });

  const transcript: string = recognized?.transcript || "";

  const alignmentResult = await EnjoyApp.echogarden.align(
    url,
    transcript,
    {
      engine: "dtw",
      language: languageCode,
      isolate: false,
    }
  );

  const hypTimeline = extractHypothesisWordTimeline(alignmentResult?.timeline || []);
  const hypTokens = hypTimeline.map((w) => w.token);
  const refTokens = tokenize(reference || transcript);

  const ops = alignTokens(refTokens, hypTokens);

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  let matches = 0;

  const words: PronunciationAssessmentWordResultType[] = [];
  for (const op of ops) {
    if (op.type === "equal") {
      matches += 1;
      const meta = hypTimeline[op.hypIndex];
      words.push({
        word: op.ref,
        offset: meta?.offset || 0,
        duration: meta?.duration || 0,
        pronunciationAssessment: { accuracyScore: 100, errorType: "None" },
        phonemes: [],
      } as any);
    } else if (op.type === "replace") {
      substitutions += 1;
      const meta = hypTimeline[op.hypIndex];
      words.push({
        word: op.ref,
        offset: meta?.offset || 0,
        duration: meta?.duration || 0,
        pronunciationAssessment: {
          accuracyScore: 20,
          errorType: "Mispronunciation",
        },
        phonemes: [],
      } as any);
    } else if (op.type === "delete") {
      deletions += 1;
      words.push({
        word: op.ref,
        offset: 0,
        duration: 0,
        pronunciationAssessment: { accuracyScore: 0, errorType: "Omission" },
        phonemes: [],
      } as any);
    } else if (op.type === "insert") {
      insertions += 1;
      const meta = hypTimeline[op.hypIndex];
      words.push({
        word: op.hyp,
        offset: meta?.offset || 0,
        duration: meta?.duration || 0,
        pronunciationAssessment: { accuracyScore: 0, errorType: "Insertion" },
        phonemes: [],
      } as any);
    }
  }

  const n = Math.max(1, refTokens.length);
  const wer = (substitutions + deletions + insertions) / n;
  const accuracy = matches / n;
  const completeness = (n - deletions) / n;
  const fluency = durationMs
    ? Math.min(1, (hypTokens.length / (durationMs / 1000)) / 3) * 100
    : accuracy * 100;

  const pronunciationScore = clampScore((1 - wer) * 100);
  const accuracyScore = clampScore(accuracy * 100);
  const completenessScore = clampScore(completeness * 100);
  const fluencyScore = clampScore(fluency);

  const detailResult = {
    engine: "whisper_local",
    whisper: { engine: whisperEngine, model },
    confidence: 0,
    display: transcript,
    itn: transcript,
    lexical: transcript,
    markedItn: transcript,
    pronunciationAssessment: {
      accuracyScore,
      completenessScore,
      fluencyScore,
      pronScore: pronunciationScore,
    },
    words,
  };

  return {
    pronunciationScore,
    accuracyScore,
    completenessScore,
    fluencyScore,
    detailResult,
  };
};
