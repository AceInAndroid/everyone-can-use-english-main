import { t } from "i18next";
import {
  Button,
  toast,
} from "@renderer/components/ui";
import {
  AISettingsProviderContext,
} from "@renderer/context";
import { useContext } from "react";
import { checkSherpaWasmModel } from "@renderer/lib/sherpa-wasm";

export const PronunciationAssessmentSettings = () => {
  const { pronunciationAssessmentConfig } =
    useContext(AISettingsProviderContext);

  const handleCheckSherpa = async () => {
    toast.promise(
      async () => {
        await checkSherpaWasmModel();
      },
      {
        loading: t("checkingSherpaModel"),
        success: t("sherpaModelIsWorkingGood"),
        error: (error: any) => t("sherpaModelIsNotWorking") + ": " + error,
      }
    );
  };

  return (
    <div className="flex items-start justify-between py-4">
      <div className="">
        <div className="flex items-center mb-2">
          <span>{t("pronunciationAssessmentService")}</span>
        </div>
        <div className="text-sm text-muted-foreground">
          {t("sherpaWasmPronunciationAssessmentDescription")}
        </div>

        <div className="text-sm text-muted-foreground mt-4 px-1 space-y-2">
          <div className="flex items-center space-x-2">
            <div className="min-w-24">{t("model")}</div>
            <div className="text-foreground">en-us-small</div>
          </div>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        <Button onClick={handleCheckSherpa}>
          {t("check")}
        </Button>
      </div>
    </div>
  );
};
