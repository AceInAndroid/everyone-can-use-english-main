import { diffWords } from "diff";
import { Button } from "@renderer/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card";

type Props = {
  score: number;
  referenceText: string;
  recognizedText: string;
  onRetry?: () => void;
};

const scoreColor = (score: number) => {
  if (score >= 90) return "text-green-600";
  if (score >= 70) return "text-yellow-600";
  return "text-red-600";
};

export function ScoreResultCard({
  score,
  referenceText,
  recognizedText,
  onRetry,
}: Props) {
  const parts = diffWords(referenceText, recognizedText);

  return (
    <Card className="shadow-lg">
      <CardHeader className="flex flex-col items-center space-y-2">
        <CardTitle className="text-center text-lg font-semibold">
          Pronunciation Score
        </CardTitle>
        <div className="text-5xl font-black tracking-tight">
          <span className={scoreColor(score)}>{score}</span>
          <span className="ml-1 text-3xl text-gray-500">/100</span>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="text-sm text-muted-foreground">Reference vs Spoke</div>
        <div className="rounded-md border bg-muted/50 p-4 leading-7">
          {parts.map((part, idx) => {
            if (part.added) {
              return (
                <span
                  key={idx}
                  className="text-xs italic text-gray-400"
                  title="Extra word"
                >
                  {part.value}
                </span>
              );
            }
            if (part.removed) {
              return (
                <span
                  key={idx}
                  className="font-semibold text-red-600 line-through"
                  title="Missed word"
                >
                  {part.value}
                </span>
              );
            }
            return (
              <span
                key={idx}
                className="font-semibold text-green-700"
                title="Matched"
              >
                {part.value}
              </span>
            );
          })}
        </div>

        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer select-none">What I heard</summary>
          <div className="mt-2 text-base text-foreground">
            {recognizedText || <span className="text-gray-400">Nothing detected</span>}
          </div>
        </details>

        <div className="flex justify-end">
          <Button variant="outline" onClick={onRetry}>
            Try Again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
