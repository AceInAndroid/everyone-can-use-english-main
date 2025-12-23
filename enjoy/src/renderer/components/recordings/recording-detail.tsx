import {
  PronunciationAssessmentScoreResult,
  WavesurferPlayer,
} from "@renderer/components";
import { Separator, ScrollArea, toast } from "@renderer/components/ui";
import { useState, useContext, useEffect } from "react";
import { AppSettingsProviderContext } from "@renderer/context";
import { Tooltip } from "react-tooltip";
import { t } from "i18next";
import { usePronunciationAssessments } from "@renderer/hooks";

export const RecordingDetail = (props: {
  recording: RecordingType;
  pronunciationAssessment?: PronunciationAssessmentType;
  onAssess?: (assessment: PronunciationAssessmentType) => void;
  onPlayOrigin?: (word: string, index: number) => void;
}) => {
  const { recording, onAssess, onPlayOrigin } = props;
  if (!recording) return;

  const [pronunciationAssessment, setPronunciationAssessment] =
    useState<PronunciationAssessmentType>(
      props.pronunciationAssessment || recording.pronunciationAssessment
    );
  const { result } = pronunciationAssessment || {};
  const [currentTime, setCurrentTime] = useState<number>(0);

  const { learningLanguage } = useContext(AppSettingsProviderContext);
  const { createAssessment } = usePronunciationAssessments();
  const [assessing, setAssessing] = useState(false);

  const assess = () => {
    if (assessing) return;
    if (result) return;
    setAssessing(true);
    createAssessment({
      recording,
      reference: recording.referenceText?.replace(/[—]/g, ", ") || "",
      language: recording.language || learningLanguage,
    })
      .then((assessment: any) => {
        onAssess && onAssess(assessment);
        setPronunciationAssessment(assessment);
      })
      .catch((err) => {
        toast.error(err.message);
      })
      .finally(() => {
        setAssessing(false);
      });
  };

  useEffect(() => {
    if (!result) {
      assess();
    } else {
      setPronunciationAssessment(
        props.pronunciationAssessment || recording.pronunciationAssessment
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, props.pronunciationAssessment]);

  return (
    <div className="">
      <div className="flex justify-center mb-6">
        <WavesurferPlayer
          id={recording.id}
          src={recording.src}
          setCurrentTime={setCurrentTime}
        />
      </div>

      <Separator />

      <ScrollArea className="min-h-72 py-4 px-8 select-text">
        {(recording?.referenceText || "").split("\n").map((line, index) => (
          <div key={index} className="mb-2 text-xl font-serif tracking-wide">
            {line}
          </div>
        ))}
        {result?.words?.length ? (
          <div className="mt-4 text-sm text-muted-foreground">
            Recognized ({result.words.length} tokens)
          </div>
        ) : null}
      </ScrollArea>

      <Separator />

      <PronunciationAssessmentScoreResult
        pronunciationScore={pronunciationAssessment?.pronunciationScore}
        accuracyScore={pronunciationAssessment?.accuracyScore}
        fluencyScore={pronunciationAssessment?.fluencyScore}
        completenessScore={pronunciationAssessment?.completenessScore}
        prosodyScore={pronunciationAssessment?.prosodyScore}
        assessing={assessing}
        onAssess={assess}
      />

      <Tooltip id="recording-tooltip" />
    </div>
  );
};
