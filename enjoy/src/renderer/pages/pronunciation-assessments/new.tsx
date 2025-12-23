import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, RotateCcw, ChevronLeft } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { Textarea } from "@renderer/components/ui/textarea";
import { Progress } from "@renderer/components/ui/progress";
import { TransformersScoringService } from "@renderer/services/TransformersScoringService";
import { ScoreResultCard } from "@renderer/components/ScoreResultCard";
import { useNavigate } from "react-router-dom"; // 需要这个来做返回跳转

type Phase = "input" | "recording" | "analyzing" | "result" | "error";

const DEFAULT_TEXT = "The quick brown fox jumps over the lazy dog.";

export default function NewPronunciationAssessmentPage() {
  const navigate = useNavigate();
  const [referenceText, setReferenceText] = useState(DEFAULT_TEXT);
  const [phase, setPhase] = useState<Phase>("input");
  const [progress, setProgress] = useState(0);
  const [recognizedText, setRecognizedText] = useState("");
  const [score, setScore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mountedRef = useRef(true);

  // 1. 生命周期管理
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopTracks(); // 确保组件卸载时释放麦克风
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

      // 2. MIME类型 安全检查
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data?.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        await analyze(blob);
      };

      recorder.start();
      setPhase("recording");
    } catch (err) {
      console.error(err);
      setError("Microphone access denied. Please check system permissions.");
      setPhase("error");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state !== "inactive") {
      mediaRecorderRef.current?.stop();
    }
    stopTracks();
  };

  const analyze = async (blob: Blob) => {
    setPhase("analyzing");
    setProgress(0);

    try {
      const service = TransformersScoringService.getInstance();

      await service.init((data) => {
        if (!mountedRef.current) return;

        // 3. 进度条逻辑修复
        if (data.status === "progress") {
          const p = data.progress ?? 0;
          // 兼容 0-1 和 0-100 两种格式
          const percentage = p <= 1 ? p * 100 : p;
          setProgress(Math.round(percentage));
        } else if (data.status === "initiate") {
          setProgress(0);
        } else if (data.status === "done") {
          setProgress(100);
        }
      });

      if (mountedRef.current) setProgress(100);

      const result = await service.score(blob, referenceText);

      if (mountedRef.current) {
        setRecognizedText(result.recognizedText);
        setScore(result.score);
        setPhase("result");
      }
    } catch (err) {
      console.error(err);
      if (mountedRef.current) {
        setError("AI Analysis failed. Please check your network connection (model download).");
        setPhase("error");
      }
    }
  };

  const reset = () => {
    setPhase("input");
    setRecognizedText("");
    setScore(null);
    setProgress(0);
    setError(null);
    chunksRef.current = [];
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 min-h-[600px]">
      {/* 头部导航 */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pronunciation Assessment</h1>
          <p className="text-sm text-muted-foreground">
            Read the text aloud to verify your pronunciation.
          </p>
        </div>
      </div>

      {phase === "input" && (
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">
              Reference Text
            </label>
            <Textarea
              rows={6}
              value={referenceText}
              onChange={(e) => setReferenceText(e.target.value)}
              className="w-full text-lg p-4 leading-relaxed resize-none"
              placeholder="Enter text here..."
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={startRecording} size="lg" className="gap-2 px-8" disabled={!referenceText.trim()}>
              <Mic className="h-5 w-5" />
              Start Recording
            </Button>
          </div>
        </div>
      )}

      {phase === "recording" && (
        <div className="flex flex-col items-center justify-center space-y-8 py-12 rounded-xl border bg-muted/10 animate-in fade-in duration-300">
          <div className="flex items-center gap-2 px-4 py-1 bg-red-100 text-red-600 rounded-full text-sm font-medium animate-pulse">
            <div className="h-2 w-2 rounded-full bg-red-600" />
            Recording...
          </div>

          <div className="px-8 text-center">
            <p className="text-3xl font-serif font-medium leading-relaxed text-foreground">
              {referenceText}
            </p>
          </div>

          <Button
            variant="destructive"
            onClick={stopRecording}
            className="h-20 w-20 rounded-full shadow-xl hover:scale-105 transition-transform flex items-center justify-center"
          >
            <Square className="h-8 w-8 fill-current" />
          </Button>
          <p className="text-sm text-muted-foreground">Click to stop</p>
        </div>
      )}

      {phase === "analyzing" && (
        <div className="flex flex-col items-center justify-center space-y-6 py-20 rounded-xl border animate-in fade-in duration-500">
          <div className="relative">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
          </div>

          <div className="w-full max-w-md space-y-2 px-8">
            <div className="flex justify-between text-sm font-medium">
              <span>AI Processing</span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-2" />
            <p className="text-xs text-muted-foreground text-center pt-2">
              {progress < 100
                ? "Downloading neural model (first time only)..."
                : "Analyzing speech patterns..."}
            </p>
          </div>
        </div>
      )}

      {phase === "result" && score !== null && (
        <div className="animate-in zoom-in-95 duration-500">
          <ScoreResultCard
            score={score}
            referenceText={referenceText}
            recognizedText={recognizedText}
            onRetry={reset}
          />
        </div>
      )}

      {phase === "error" && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-6 text-center space-y-4">
          <p className="text-destructive font-medium text-lg">
            {error || "Something went wrong."}
          </p>
          <Button variant="outline" onClick={reset} className="gap-2">
            <RotateCcw className="h-4 w-4" />
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
