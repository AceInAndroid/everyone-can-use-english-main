import { remove } from "fs-extra";

export interface SherpaToken {
    text: string;
    start: number;
    end: number;
    confidence: number; // 0.0 - 1.0
}

export interface AssessmentInput {
    referenceText: string;
    recognizedTokens: SherpaToken[];
}

export type WordStatus = 'correct' | 'mispronounced' | 'omitted' | 'inserted';

export interface WordResult {
    word: string;             // Word from reference text
    status: WordStatus;
    score: number;            // 0-100
    timestamps?: { start: number; end: number };
}

export interface AssessmentReport {
    overallScore: number;     // Weighted average
    fluencyScore: number;     // Based on pauses
    integrityScore: number;   // Match rate
    pronunciationScore: number; // Accuracy based on confidence
    details: WordResult[];    // Word-by-word details
}

/**
 * ScoringEngine
 * Calculates pronunciation assessment scores based on local ASR results.
 */
export const ScoringEngine = {
    assess(input: AssessmentInput): AssessmentReport {
        const { referenceText, recognizedTokens } = input;

        // 0. Handle empty input
        if (!referenceText || referenceText.trim().length === 0) {
            return emptyReport();
        }

        // 1. Normalization
        const refWords = normalizeAndTokenize(referenceText);
        const recWords = recognizedTokens.map(t => ({
            ...t,
            normalized: normalize(t.text)
        }));

        if (recWords.length === 0) {
            // All omitted
            return {
                overallScore: 0,
                fluencyScore: 0,
                integrityScore: 0,
                pronunciationScore: 0,
                details: refWords.map(w => ({
                    word: w,
                    status: 'omitted',
                    score: 0
                }))
            };
        }

        // 2. Alignment (Need DP for sequence alignment)
        const alignment = alignSequence(refWords, recWords);

        // 3. Scoring
        const details: WordResult[] = [];
        let totalPronScore = 0;
        let matchCount = 0;
        let refCount = refWords.length;

        alignment.forEach(item => {
            const { type, refIndex, recIndex } = item;

            if (type === 'match') {
                const refWord = refWords[refIndex];
                const recToken = recWords[recIndex];
                const score = Math.round((recToken.confidence ?? 0.95) * 100);

                details.push({
                    word: refWord,
                    status: 'correct',
                    score: score,
                    timestamps: { start: recToken.start, end: recToken.end }
                });

                totalPronScore += score;
                matchCount++;
            } else if (type === 'substitution') {
                const refWord = refWords[refIndex];
                const recToken = recWords[recIndex];
                // Calculate similarity for penalty
                const similarity = stringSimilarity(refWord, recToken.normalized);
                // Base score 40, max 60 based on similarity
                const score = 40 + Math.round(similarity * 20);

                details.push({
                    word: refWord,
                    status: 'mispronounced',
                    score: score,
                    timestamps: { start: recToken.start, end: recToken.end }
                });

                // Substitution counts towards pronunciation score but with low value
                totalPronScore += score;
                // Verify if substitution counts as "integrity" match? Usually no.
            } else if (type === 'deletion') {
                const refWord = refWords[refIndex];
                details.push({
                    word: refWord,
                    status: 'omitted',
                    score: 0
                });
                // 0 score
            } else if (type === 'insertion') {
                // Ignored in WordResult (as per requirements: "Don't mess up WordResult array")
                // But might affect fluency?
            }
        });

        // 4. Fluency Calculation
        let pauses = 0;
        for (let i = 1; i < recognizedTokens.length; i++) {
            const gap = recognizedTokens[i].start - recognizedTokens[i - 1].end;
            if (gap > 0.5) {
                pauses++;
            }
        }
        // FluencyScore = 100 - (pauses * 5), min 0
        const fluencyScore = Math.max(0, 100 - (pauses * 5));

        // 5. Aggregate Scores
        // Pronunciation Score: Average of matched/substituted words?
        // Usually average score of ALL reference words (omission = 0).
        // Let's use average of details scores.
        const totalWordScore = details.reduce((sum, w) => sum + w.score, 0);
        const pronunciationScore = Math.round(totalWordScore / Math.max(1, details.length));

        // Integrity Score: Match Ratio
        // Percentage of 'correct' words. 
        // Or (Match / Total Ref).
        const integrityScore = Math.round((matchCount / refCount) * 100);

        // Overall = (Pron * 0.5) + (Integrity * 0.3) + (Fluency * 0.2)
        const overallScore = Math.round(
            (pronunciationScore * 0.5) + (integrityScore * 0.3) + (fluencyScore * 0.2)
        );

        return {
            overallScore,
            fluencyScore,
            integrityScore,
            pronunciationScore,
            details
        };
    }
};

// --- Helpers ---

function emptyReport(): AssessmentReport {
    return {
        overallScore: 0,
        fluencyScore: 0,
        integrityScore: 0,
        pronunciationScore: 0,
        details: []
    };
}

function normalize(text: string): string {
    return text.toLowerCase().replace(/[.,?!;:""'']/g, "").trim();
}

function normalizeAndTokenize(text: string): string[] {
    // "Hello, world!" -> ["hello", "world"]
    // Handle punctuation
    return text.toLowerCase()
        .replace(/[.,?!;:""'']/g, " ")
        .split(/\s+/)
        .filter(w => w.length > 0);
}

// DP Alignment
type AlignmentType = 'match' | 'substitution' | 'deletion' | 'insertion';
interface AlignmentItem {
    type: AlignmentType;
    refIndex: number; // -1 if insertion
    recIndex: number; // -1 if deletion
}

function alignSequence(ref: string[], rec: { normalized: string }[]): AlignmentItem[] {
    const n = ref.length;
    const m = rec.length;

    // dp[i][j] = min cost to align ref[0..i-1] with rec[0..j-1]
    const dp: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
    const path: AlignmentType[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill('match'));

    // Init
    for (let i = 0; i <= n; i++) dp[i][0] = i; // Deletions
    for (let j = 0; j <= m; j++) dp[0][j] = j; // Insertions

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const isMatch = ref[i - 1] === rec[j - 1].normalized;
            const substitutionCost = isMatch ? 0 : 1;

            // Costs
            const delCost = dp[i - 1][j] + 1;
            const insCost = dp[i][j - 1] + 1;
            const subCost = dp[i - 1][j - 1] + substitutionCost;

            let minCost = subCost;
            let op: AlignmentType = isMatch ? 'match' : 'substitution';

            if (delCost < minCost) {
                minCost = delCost;
                op = 'deletion';
            }
            if (insCost < minCost) {
                minCost = insCost;
                op = 'insertion';
            }

            // Bias towards Substitution over Insertion+Deletion if words are similar?
            // Levenshtein usually just takes min.

            dp[i][j] = minCost;
            path[i][j] = op;
        }
    }

    // Backtrack
    const alignment: AlignmentItem[] = [];
    let i = n;
    let j = m;

    while (i > 0 || j > 0) {
        if (i > 0 && j > 0) {
            const op = path[i][j];
            // Re-check logic because standard backtracking relies on cost values
            // Sometimes path matrix is not enough if priority matters.
            // Let's re-derive op from costs to be safe or ensure strict priority.

            const currentCost = dp[i][j];
            const isMatch = ref[i - 1] === rec[j - 1].normalized;
            const subCost = dp[i - 1][j - 1] + (isMatch ? 0 : 1);
            const delCost = dp[i - 1][j] + 1;
            const insCost = dp[i][j - 1] + 1;

            if (currentCost === subCost) {
                alignment.push({
                    type: isMatch ? 'match' : 'substitution',
                    refIndex: i - 1,
                    recIndex: j - 1
                });
                i--; j--;
            } else if (currentCost === delCost) {
                alignment.push({ type: 'deletion', refIndex: i - 1, recIndex: -1 });
                i--;
            } else {
                alignment.push({ type: 'insertion', refIndex: -1, recIndex: j - 1 });
                j--;
            }
        } else if (i > 0) {
            alignment.push({ type: 'deletion', refIndex: i - 1, recIndex: -1 });
            i--;
        } else {
            alignment.push({ type: 'insertion', refIndex: -1, recIndex: j - 1 });
            j--;
        }
    }

    return alignment.reverse();
}

// Levenshtein for strings (lightweight)
function computeLevenshtein(a: string, b: string): number {
    const tmp = b;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];

    // increment along the first column of each row
    let i;
    for (i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }

    // increment each column in the first row
    let j;
    for (j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    // Fill in the rest of the matrix
    for (i = 1; i <= b.length; i++) {
        for (j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) == a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, // substitution
                    Math.min(matrix[i][j - 1] + 1, // insertion
                        matrix[i - 1][j] + 1)); // deletion
            }
        }
    }

    return matrix[b.length][a.length];
}

function stringSimilarity(a: string, b: string): number {
    const dist = computeLevenshtein(a, b);
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    return 1.0 - (dist / maxLen);
}
