import { t } from "i18next";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from "@renderer/components/ui";
import {
  AISettingsProviderContext,
  AppSettingsProviderContext,
} from "@renderer/context";
import { WHISPER_MODELS } from "@/constants";
import { PronunciationAssessmentEngineEnum } from "@/types/enums";
import { useContext, useMemo } from "react";
import { checkSherpaWasmModel } from "@renderer/lib/sherpa-wasm";

export const PronunciationAssessmentSettings = () => {
  const { EnjoyApp, user } = useContext(AppSettingsProviderContext);
  const { pronunciationAssessmentConfig, setPronunciationAssessmentConfig } =
    useContext(AISettingsProviderContext);
  const isGuest = Boolean(user?.isGuest);

  const config = useMemo(() => {
    return (
      pronunciationAssessmentConfig || {
        engine: PronunciationAssessmentEngineEnum.AZURE,
        whisper: { engine: "whisper", model: "tiny" },
        sherpa: { modelId: "en-us-small" },
      }
    ) as PronunciationAssessmentConfigType;
  }, [pronunciationAssessmentConfig]);

  const updateConfig = async (next: PronunciationAssessmentConfigType) => {
    await setPronunciationAssessmentConfig(next);
    toast.success(t("saved"));
  };

  const whisperEngine = (config.whisper?.engine || "whisper") as "whisper" | "whisper.cpp";
  const whisperModel = config.whisper?.model || "tiny";

  const handleCheckLocal = async () => {
    const echogardenConfig: EchogardenSttConfigType = {
      engine: whisperEngine,
      whisper: { model: whisperModel },
      whisperCpp: { model: whisperModel },
    };

    toast.promise(
      async () => {
        const { success, log } = await EnjoyApp.echogarden.checkModel(
          echogardenConfig
        );
        if (success) return Promise.resolve();
        return Promise.reject(log);
      },
      {
        loading: t("checkingWhisperModel"),
        success: t("whisperModelIsWorkingGood"),
        error: (error) => t("whisperModelIsNotWorking") + ": " + error,
      }
    );
  };

  const handleCheckSherpa = async () => {
    toast.promise(
      async () => {
        await checkSherpaWasmModel();
      },
      {
        loading: t("checkingSherpaModel"),
        success: t("sherpaModelIsWorkingGood"),
        error: (error) => t("sherpaModelIsNotWorking") + ": " + error,
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
          {config.engine === PronunciationAssessmentEngineEnum.AZURE &&
            t("azurePronunciationAssessmentDescription")}
          {config.engine === PronunciationAssessmentEngineEnum.WHISPER_LOCAL &&
            t("localWhisperPronunciationAssessmentDescription")}
          {config.engine === PronunciationAssessmentEngineEnum.SHERPA_WASM &&
            t("sherpaWasmPronunciationAssessmentDescription")}
        </div>

        {config.engine === PronunciationAssessmentEngineEnum.WHISPER_LOCAL && (
          <div className="text-sm text-muted-foreground mt-4 px-1 space-y-3">
            <div className="flex items-center space-x-2">
              <div className="min-w-24">{t("whisperEngine")}</div>
              <Select
                value={whisperEngine}
                onValueChange={(value) => {
                  void updateConfig({
                    ...config,
                    whisper: {
                      engine: value as "whisper" | "whisper.cpp",
                      model: whisperModel,
                    },
                  }).catch((error) => toast.error(error.message));
                }}
              >
                <SelectTrigger className="min-w-44">
                  <SelectValue placeholder="engine" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="whisper">Whisper</SelectItem>
                  <SelectItem value="whisper.cpp">Whisper.cpp</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2">
              <div className="min-w-24">{t("whisperModel")}</div>
              <Select
                value={whisperModel}
                onValueChange={(value) => {
                  void updateConfig({
                    ...config,
                    whisper: { engine: whisperEngine, model: value },
                  }).catch((error) => toast.error(error.message));
                }}
              >
                <SelectTrigger className="min-w-44">
                  <SelectValue placeholder="model" />
                </SelectTrigger>
                <SelectContent>
                  {WHISPER_MODELS.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {config.engine === PronunciationAssessmentEngineEnum.SHERPA_WASM && (
          <div className="text-sm text-muted-foreground mt-4 px-1 space-y-2">
            <div className="flex items-center space-x-2">
              <div className="min-w-24">{t("model")}</div>
              <div className="text-foreground">en-us-small</div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center space-x-2">
        <Select
          value={config.engine}
          onValueChange={(value) => {
            void updateConfig({
              ...config,
              engine: value as PronunciationAssessmentEngineEnum,
              whisper: config.whisper || { engine: "whisper", model: "tiny" },
              sherpa: config.sherpa || { modelId: "en-us-small" },
            }).catch((error) => toast.error(error.message));
          }}
        >
          <SelectTrigger className="min-w-fit">
            <SelectValue placeholder="service"></SelectValue>
          </SelectTrigger>
        <SelectContent>
          <SelectItem
            disabled={isGuest}
            value={PronunciationAssessmentEngineEnum.AZURE}
          >
            Azure
          </SelectItem>
          <SelectItem value={PronunciationAssessmentEngineEnum.WHISPER_LOCAL}>
            {t("localWhisper")}
          </SelectItem>
          <SelectItem value={PronunciationAssessmentEngineEnum.SHERPA_WASM}>
            {t("localSherpaWasm")}
          </SelectItem>
        </SelectContent>
      </Select>

        {config.engine === PronunciationAssessmentEngineEnum.WHISPER_LOCAL && (
          <Button onClick={handleCheckLocal} variant="secondary" size="sm">
            {t("check")}
          </Button>
        )}

        {config.engine === PronunciationAssessmentEngineEnum.SHERPA_WASM && (
          <Button onClick={handleCheckSherpa} variant="secondary" size="sm">
            {t("check")}
          </Button>
        )}
      </div>
    </div>
  );
};
