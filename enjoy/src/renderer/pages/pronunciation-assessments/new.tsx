import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { Progress } from "@renderer/components/ui/progress";
import { TransformersScoringService } from "@renderer/services/TransformersScoringService";
import { ScoreResultCard } from "@renderer/components/ScoreResultCard";

type Phase = "input" | "recording" | "analyzing" | "result" | "error";

const DEFAULT_TEXT = "The quick brown fox jumps over the lazy dog.";

export default function NewPronunciationAssessmentPage() {
  const [referenceText, setReferenceText] = useState(DEFAULT_TEXT);
  const [phase, setPhase] = useState<Phase>("input");
  const [progress, setProgress] = useState(0);
  const [recognizedText, setRecognizedText] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      stopTracks();
    };
  }, []);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream, {
        mimeType: "audio/webm",
      });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data?.size) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await analyze(blob);
      };

      recorder.start();
      setPhase("recording");
    } catch (err) {
      console.error(err);
      setError("Failed to access microphone. Please check permissions.");
      setPhase("error");
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    stopTracks();
  };

  const analyze = async (blob: Blob) => {
    setPhase("analyzing");
    setProgress(0);

    try {
      const service = TransformersScoringService.getInstance();
      await service.init((data) => {
        if (typeof data?.progress === "number") {
          setProgress(Math.round(data.progress * 100));
        } else if (data.loaded && data.total) {
          setProgress(Math.round((data.loaded / data.total) * 100));
        }
      });

      setProgress(100);
      const result = await service.score(blob, referenceText);
      setRecognizedText(result.recognizedText);
      setScore(result.score);
      setPhase("result");

      // Optional persistence hook:
      // EnjoyApp.pronunciationAssessments?.create?.({ score: result.score, referenceText, recognizedText: result.recognizedText });
    } catch (err) {
      console.error(err);
      setError("Analysis failed. Please try again.");
      setPhase("error");
    }
  };

  const reset = () => {
    setPhase("input");
    setRecognizedText("");
    setScore(null);
    setProgress(0);
    setError(null);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Pronunciation Assessment</h1>
        <p className="text-sm text-muted-foreground">
          Read the sentence aloud. We&apos;ll score based on what we hear.
        </p>
      </div>

      {phase === "input" && (
        <div className="space-y-4">
          <label className="text-sm font-medium text-foreground">Reference Text</label>
          <Textarea
            rows={4}
            value={referenceText}
            onChange={(e) => setReferenceText(e.target.value)}
            className="w-full"
          />
          <div className="flex justify-end">
            <Button onClick={startRecording} className="gap-2">
              <Mic className="h-4 w-4" />
              Start Recording
            </Button>
          </div>
        </div>
      )}

      {phase === "recording" && (
        <div className="space-y-4 rounded-lg border p-6">
          <div className="flex items-center gap-2 text-red-600">
            <span className="h-2 w-2 animate-ping rounded-full bg-red-500" />
            Recording... Click stop when finished.
          </div>
          <div className="rounded-md bg-muted/50 p-4 text-lg leading-7">
            {referenceText}
          </div>
          <div className="flex justify-center gap-3">
            <Button variant="destructive" onClick={stopRecording} className="gap-2">
              <Square className="h-4 w-4" />
              Stop
            </Button>
          </div>
        </div>
      )}

      {phase === "analyzing" && (
        <div className="space-y-4 rounded-lg border p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Analyzing speech...
          </div>
          <Progress value={progress} />
          <div className="text-xs text-muted-foreground">
            {progress < 100 ? "Downloading model / Running inference" : "Finalizing..."}
          </div>
        </div>
      )}

      {phase === "result" && score !== null && (
        <ScoreResultCard
          score={score}
          referenceText={referenceText}
          recognizedText={recognizedText}
          onRetry={reset}
        />
      )}

      {phase === "error" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-700">
          {error || "Something went wrong."}
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={reset} className="gap-2">
              <RotateCcw className="h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
