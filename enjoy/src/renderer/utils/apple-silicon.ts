type ChipInfo = { brandString?: string; hwModel?: string } | null | undefined;

export type WhisperCppRecommendedTuning = {
  threadCount: number;
  decoderCap: number;
  topCandidateCount: number;
  beamCount: number;
};

export function getWhisperCppRecommendedTuning(params: {
  chipInfo: ChipInfo;
  hardwareConcurrency?: number;
}): WhisperCppRecommendedTuning {
  const hardwareConcurrency = params.hardwareConcurrency || 4;
  const brand = (params.chipInfo?.brandString || "").toLowerCase();

  const gen =
    brand.includes("m4") ? 4 :
    brand.includes("m3") ? 3 :
    brand.includes("m2") ? 2 :
    brand.includes("m1") ? 1 :
    0;

  const tier =
    brand.includes("ultra") ? "ultra" :
    brand.includes("max") ? "max" :
    brand.includes("pro") ? "pro" :
    "base";

  // Baseline targets:
  // - M1 base: conservative
  // - M4 + Pro/Max/Ultra: more aggressive
  let threadTarget = Math.min(8, Math.max(4, Math.floor(hardwareConcurrency * 0.75)));
  let decoderTarget = 5;

  if (gen === 1 && tier === "base") {
    threadTarget = 4;
    decoderTarget = 3;
  } else if (gen === 1 && (tier === "pro" || tier === "max" || tier === "ultra")) {
    threadTarget = 6;
    decoderTarget = 5;
  } else if (gen === 2 && tier === "base") {
    threadTarget = 6;
    decoderTarget = 5;
  } else if (gen === 2 && (tier === "pro" || tier === "max" || tier === "ultra")) {
    threadTarget = 8;
    decoderTarget = tier === "pro" ? 6 : 7;
  } else if (gen === 3 && tier === "base") {
    threadTarget = 6;
    decoderTarget = 5;
  } else if (gen === 3 && (tier === "pro" || tier === "max" || tier === "ultra")) {
    threadTarget = 8;
    decoderTarget = tier === "pro" ? 6 : 7;
  } else if (gen === 4 && tier === "base") {
    threadTarget = 8;
    decoderTarget = 6;
  } else if (gen === 4 && (tier === "pro" || tier === "max" || tier === "ultra")) {
    threadTarget = 8;
    decoderTarget = tier === "pro" ? 7 : 8;
  }

  // Finalize with platform constraints.
  const threadCount = Math.min(8, Math.max(2, Math.min(threadTarget, hardwareConcurrency)));
  const decoderCap = Math.min(8, threadCount);

  // Must stay <= decoderCap to avoid whisper.cpp "too many decoders requested".
  const topCandidateCount = Math.max(1, Math.min(decoderTarget, decoderCap));
  const beamCount = Math.max(1, Math.min(decoderTarget, decoderCap));

  return { threadCount, decoderCap, topCandidateCount, beamCount };
}
