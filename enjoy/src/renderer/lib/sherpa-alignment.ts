import { TimelineEntry } from "echogarden/dist/utilities/Timeline";

export const WORD_PATTERN = /[\p{L}\p{N}'’]+/gu;
export const MIN_WORD_DURATION = 0.05;
export const START_PADDING_SEC = 0.2;
export const END_PADDING_SEC = 0.3;

export type SherpaWordTiming = {
  original: string;
  normalized: string;
  startTime: number;
  endTime: number;
};

export type WordToken = {
  original: string;
  normalized: string;
};

export type AlignmentOp =
  | { type: "equal"; refIndex: number; hypIndex: number }
  | { type: "replace"; refIndex: number; hypIndex: number }
  | { type: "delete"; refIndex: number }
  | { type: "insert"; hypIndex: number };

export const normalizeWordForAlignment = (word: string) =>
  word
    ?.normalize?.("NFKD")
    ?.replace(/[“”"()\[\],.:;!?]/g, "")
    ?.replace(/[\u0300-\u036f]/g, "")
    ?.toLowerCase()
    ?.trim() || "";

export const tokenizeForAlignment = (text: string): WordToken[] => {
  if (!text) return [];
  const tokens: WordToken[] = [];
  const iterator = text.matchAll(WORD_PATTERN);
  for (const match of iterator) {
    const original = match[0];
    const normalized = normalizeWordForAlignment(original);
    if (normalized) {
      tokens.push({ original, normalized });
    }
  }
  return tokens;
};

const levenshteinDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
};

const tokensRoughlyMatch = (left: string, right: string) => {
  if (left === right) return true;
  if (!left || !right) return false;
  const distance = levenshteinDistance(left, right);
  const maxLen = Math.max(left.length, right.length) || 1;
  return distance / maxLen <= 0.45;
};

export const computeAlignmentOps = (
  refTokens: string[],
  hypTokens: string[]
): AlignmentOp[] => {
  const n = refTokens.length;
  const m = hypTokens.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0)
  );

  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const similar = tokensRoughlyMatch(refTokens[i - 1], hypTokens[j - 1]);
      const cost = similar ? 0 : 1;
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
      ops.push({ type: "delete", refIndex: i - 1 });
      i -= 1;
      continue;
    }
    if (j > 0 && dp[i][j] === dp[i][j - 1] + 1) {
      ops.push({ type: "insert", hypIndex: j - 1 });
      j -= 1;
      continue;
    }

    const similar = tokensRoughlyMatch(refTokens[i - 1], hypTokens[j - 1]);
    ops.push({
      type: similar ? "equal" : "replace",
      refIndex: i - 1,
      hypIndex: j - 1,
    });
    i -= 1;
    j -= 1;
  }

  return ops.reverse();
};

export const safeNumber = (value: unknown, fallback: number) => {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
};

export const padWordWindow = (start: number, end: number) => {
  const safeStart = safeNumber(start, 0);
  const safeEnd = Math.max(safeStart + MIN_WORD_DURATION, safeNumber(end, safeStart));
  const paddedStart = Math.max(0, safeStart - START_PADDING_SEC);
  const paddedEnd = Math.max(paddedStart + MIN_WORD_DURATION, safeEnd + END_PADDING_SEC);
  return { start: paddedStart, end: paddedEnd };
};

export const parseSherpaWordTimings = (
  alignment: any,
  fallbackDuration: number
): SherpaWordTiming[] => {
  const words: SherpaWordTiming[] = [];
  const pushWord = (original?: string, start?: number, end?: number) => {
    if (!original) return;
    const normalized = normalizeWordForAlignment(original);
    if (!normalized) return;
    const startTime = safeNumber(start, 0);
    const endTime = Math.max(
      startTime + MIN_WORD_DURATION,
      safeNumber(end, startTime + MIN_WORD_DURATION)
    );
    words.push({ original, normalized, startTime, endTime });
  };

  if (Array.isArray(alignment?.words)) {
    alignment.words.forEach((word: any) => {
      pushWord(
        word?.word ?? word?.text,
        word?.start ?? word?.start_time,
        word?.end ?? word?.end_time
      );
    });
  }

  if (Array.isArray(alignment?.segments)) {
    alignment.segments.forEach((segment: any) => {
      if (Array.isArray(segment?.words)) {
        segment.words.forEach((word: any) => {
          pushWord(
            word?.word ?? word?.text,
            word?.start ?? word?.start_time,
            word?.end ?? word?.end_time
          );
        });
      } else if (segment?.text) {
        pushWord(
          segment.text,
          segment.start ?? segment.start_time,
          segment.end ?? segment.end_time
        );
      }
    });
  }

  if (words.length === 0 && Array.isArray(alignment?.tokens)) {
    const tokens = alignment.tokens as string[];
    const timestamps = Array.isArray(alignment?.timestamps)
      ? alignment.timestamps
      : Array(tokens.length + 1).fill(0);
    tokens.forEach((token, index) => {
      const start = safeNumber(timestamps[index], index * MIN_WORD_DURATION);
      const end = safeNumber(timestamps[index + 1], start + MIN_WORD_DURATION);
      pushWord(token, start, end);
    });
  }

  if (words.length === 0 && typeof alignment?.text === "string") {
    const tokenized = tokenizeForAlignment(alignment.text);
    const totalDuration = Math.max(
      fallbackDuration,
      MIN_WORD_DURATION * tokenized.length
    );
    const step = totalDuration / Math.max(1, tokenized.length);
    tokenized.forEach((token, idx) => {
      const start = idx * step;
      const end = start + step;
      words.push({
        original: token.original,
        normalized: token.normalized,
        startTime: start,
        endTime: end,
      });
    });
  }

  return words.sort((a, b) => a.startTime - b.startTime);
};

const buildTimelineEntriesFromOps = (
  tokens: WordToken[],
  sherpaWords: SherpaWordTiming[],
  ops: AlignmentOp[]
): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];
  let lastEnd = 0;

  ops.forEach((op) => {
    if (op.type === "equal" || op.type === "replace") {
      const word = tokens[op.refIndex];
      const meta = sherpaWords[op.hypIndex];
      const { start, end } = padWordWindow(meta.startTime, meta.endTime);
      entries.push({
        type: "word",
        text: word?.original || meta.original,
        startTime: start,
        endTime: end,
        timeline: [],
      } as TimelineEntry);
      lastEnd = end;
    } else if (op.type === "delete") {
      const word = tokens[op.refIndex];
      const start = Math.max(0, lastEnd - 0.1);
      const end = start + 0.4;
      entries.push({
        type: "word",
        text: word?.original || "",
        startTime: start,
        endTime: end,
        timeline: [],
      } as TimelineEntry);
      lastEnd = end;
    }
    // Insert operations correspond to extra Sherpa tokens and are intentionally ignored
    // when constructing the primary transcript timeline.
  });

  return entries;
};

export const buildWordTimelineFromSherpa = (
  referenceText: string,
  sherpaWords: SherpaWordTiming[]
): { timeline: TimelineEntry[]; tokens: WordToken[]; ops: AlignmentOp[] } => {
  const tokens = tokenizeForAlignment(referenceText);
  if (!tokens.length || !sherpaWords.length) {
    return { timeline: [], tokens, ops: [] };
  }

  const ops = computeAlignmentOps(
    tokens.map((token) => token.normalized),
    sherpaWords.map((word) => word.normalized)
  );

  return {
    timeline: buildTimelineEntriesFromOps(tokens, sherpaWords, ops),
    tokens,
    ops,
  };
};
