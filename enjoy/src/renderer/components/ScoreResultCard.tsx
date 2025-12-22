import { diffWords } from "diff";
import { RotateCcw } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@renderer/components/ui/card";

type Props = {
  score: number;
  referenceText: string;
  recognizedText: string;
  onRetry?: () => void;
};

const getScoreConfig = (score: number) => {
  if (score >= 90) return { color: "text-green-600", label: "Excellent!" };
  if (score >= 70) return { color: "text-yellow-600", label: "Good Job" };
  return { color: "text-red-600", label: "Keep Trying" };
};

export function ScoreResultCard({
  score,
  referenceText,
  recognizedText,
  onRetry,
}: Props) {
  const parts = diffWords(referenceText, recognizedText, { ignoreCase: true });
  const { color, label } = getScoreConfig(score);

  return (
    <Card className="w-full max-w-2xl mx-auto shadow-lg">
      <CardHeader className="flex flex-col items-center space-y-4 pb-2">
        <CardTitle className="text-center text-xl font-semibold text-muted-foreground">
          Assessment Result
        </CardTitle>
        <div className="flex flex-col items-center">
          <div className={`text-6xl font-black tracking-tighter ${color}`}>
            {score}
          </div>
          <p className={`mt-2 font-medium ${color}`}>{label}</p>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="space-y-2">
          <div className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Feedback
          </div>
          <div className="rounded-xl border bg-slate-50 dark:bg-slate-900 p-5 leading-loose text-lg flex flex-wrap gap-x-1.5 items-baseline">
            {parts.map((part, idx) => {
              if (part.added) {
                return (
                  <span
                    key={idx}
                    className="text-sm text-red-400 line-through decoration-red-300 opacity-80"
                    title="Extra word detected"
                  >
                    {part.value}
                  </span>
                );
              }
              if (part.removed) {
                return (
                  <span
                    key={idx}
                    className="font-bold text-red-600 underline decoration-wavy decoration-red-400 underline-offset-4"
                    title="Missed word"
                  >
                    {part.value}
                  </span>
                );
              }
              return (
                <span
                  key={idx}
                  className="font-medium text-green-600 dark:text-green-400"
                >
                  {part.value}
                </span>
              );
            })}
          </div>
        </div>

        <details className="group">
          <summary className="cursor-pointer text-sm text-muted-foreground flex items-center gap-2 select-none hover:text-foreground transition-colors">
            <span>Show raw transcript</span>
            <div className="h-px flex-1 bg-border" />
          </summary>
          <div className="mt-3 rounded-md border bg-muted p-3 text-sm italic text-muted-foreground">
            "{recognizedText || "No speech detected"}"
          </div>
        </details>

        <div className="flex justify-center pt-2">
          <Button size="lg" onClick={onRetry} className="gap-2 px-8">
            <RotateCcw className="h-4 w-4" />
            Try Again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
