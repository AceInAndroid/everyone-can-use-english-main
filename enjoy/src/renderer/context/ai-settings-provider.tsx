import { createContext, useEffect, useState, useContext, useRef } from "react";
import {
  AppSettingsProviderContext,
  DbProviderContext,
} from "@renderer/context";
import {
  PronunciationAssessmentEngineEnum,
  SttEngineOptionEnum,
  UserSettingKeyEnum,
} from "@/types/enums";
import { GPT_PROVIDERS, TTS_PROVIDERS } from "@renderer/components";
import { WHISPER_MODELS } from "@/constants";
import log from "electron-log/renderer";

const logger = log.scope("ai-settings-provider.tsx");

type AISettingsProviderState = {
  sttEngine?: SttEngineOptionEnum;
  setSttEngine?: (name: string) => Promise<void>;
  openai?: LlmProviderType;
  setOpenai?: (config: LlmProviderType) => void;
  setGptEngine?: (engine: GptEngineSettingType) => void;
  currentGptEngine?: GptEngineSettingType;
  gptProviders?: typeof GPT_PROVIDERS;
  ttsProviders?: typeof TTS_PROVIDERS;
  ttsConfig?: TtsConfigType;
  setTtsConfig?: (config: TtsConfigType) => Promise<void>;
  echogardenSttConfig?: EchogardenSttConfigType;
  setEchogardenSttConfig?: (config: EchogardenSttConfigType) => Promise<void>;
  pronunciationAssessmentConfig?: PronunciationAssessmentConfigType;
  setPronunciationAssessmentConfig?: (
    config: PronunciationAssessmentConfigType
  ) => Promise<void>;
};

const initialState: AISettingsProviderState = {};

export const AISettingsProviderContext =
  createContext<AISettingsProviderState>(initialState);

export const AISettingsProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { EnjoyApp, libraryPath, user, apiUrl, webApi, learningLanguage } =
    useContext(AppSettingsProviderContext);
  const isGuest = Boolean(user?.isGuest);
  const mountedRef = useRef(true);
  const [gptProviders, setGptProviders] = useState<any>(GPT_PROVIDERS);
  const [ttsProviders, setTtsProviders] = useState<any>(TTS_PROVIDERS);
  const db = useContext(DbProviderContext);

  const [sttEngine, setSttEngine] = useState<SttEngineOptionEnum>(
    SttEngineOptionEnum.ENJOY_AZURE
  );
  const [ttsConfig, setTtsConfig] = useState<TtsConfigType>(null);
  const [echogardenSttConfig, setEchogardenSttConfig] =
    useState<EchogardenSttConfigType>(null);
  const [pronunciationAssessmentConfig, setPronunciationAssessmentConfig] =
    useState<PronunciationAssessmentConfigType>(null);
  const [gptEngine, setGptEngine] = useState<GptEngineSettingType>({
    name: "enjoyai",
    models: {
      default: "gpt-4o",
    },
  });
  const [openai, setOpenai] = useState<LlmProviderType>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshGptProviders = async () => {
    let providers = GPT_PROVIDERS;

    try {
      if (!isGuest && webApi?.config) {
        const config = await webApi.config("gpt_providers");
        providers = Object.assign(providers, config);
      }
    } catch (e) {
      console.warn(`Failed to fetch remote GPT config: ${e.message}`);
    }

    try {
      const response = await fetch(providers["ollama"]?.baseUrl + "/api/tags");
      providers["ollama"].models = (await response.json()).models.map(
        (m: any) => m.name
      );
    } catch (e) {
      console.warn(`No ollama server found: ${e.message}`);
    }

    if (openai?.models) {
      providers["openai"].models = openai.models.split(",");
    }

    if (isGuest) {
      providers = { openai: providers.openai };
    }

    if (!mountedRef.current) return;
    setGptProviders({ ...providers });
  };

  const refreshTtsProviders = async () => {
    let providers = TTS_PROVIDERS;

    try {
      if (!isGuest && webApi?.config) {
        const config = await webApi.config("tts_providers_v2");
        providers = Object.assign(providers, config);
      }
    } catch (e) {
      console.warn(`Failed to fetch remote TTS config: ${e.message}`);
    }

    if (isGuest) {
      providers = { openai: providers.openai };
    }

    if (!mountedRef.current) return;
    setTtsProviders({ ...providers });
  };

  const refreshTtsConfig = async () => {
    let config = await EnjoyApp.userSettings.get(UserSettingKeyEnum.TTS_CONFIG);
    if (!config) {
      config = {
        engine: isGuest ? "openai" : "enjoyai",
        model: "openai/tts-1",
        voice: "alloy",
        language: learningLanguage,
      };
      EnjoyApp.userSettings.set(UserSettingKeyEnum.TTS_CONFIG, config);
    }
    if (isGuest && config.engine !== "openai") {
      config = {
        ...config,
        engine: "openai",
        model: config.model?.startsWith("openai/") ? config.model : "openai/tts-1",
        voice: config.voice || "alloy",
      };
      EnjoyApp.userSettings.set(UserSettingKeyEnum.TTS_CONFIG, config);
    }
    if (!mountedRef.current) return;
    setTtsConfig(config);
  };

  const handleSetTtsConfig = async (config: TtsConfigType) => {
    return EnjoyApp.userSettings
      .set(UserSettingKeyEnum.TTS_CONFIG, config)
      .then(() => {
        if (!mountedRef.current) return;
        setTtsConfig(config);
      });
  };

  const refreshEchogardenSttConfig = async () => {
    let config = await EnjoyApp.userSettings.get(UserSettingKeyEnum.ECHOGARDEN);

    if (!config) {
      let model = "tiny";
      const whisperModel =
        (await EnjoyApp.userSettings.get(UserSettingKeyEnum.WHISPER)) || "";
      if (WHISPER_MODELS.includes(whisperModel)) {
        model = whisperModel;
      } else {
        if (whisperModel.match(/tiny/)) {
          model = "tiny";
        } else if (whisperModel.match(/base/)) {
          model = "base";
        } else if (whisperModel.match(/small/)) {
          model = "small";
        } else if (whisperModel.match(/medium/)) {
          model = "medium";
        } else if (whisperModel.match(/large/)) {
          model = "large-v3-turbo";
        }

        if (
          learningLanguage.match(/en/) &&
          model.match(/tiny|base|small|medium/)
        ) {
          model = `${model}.en`;
        }
      }

      config = {
        engine: "whisper",
        whisper: {
          model,
          temperature: 0.2,
          prompt: "",
          encoderProvider: "cpu",
          decoderProvider: "cpu",
        },
      };
      EnjoyApp.userSettings.set(UserSettingKeyEnum.ECHOGARDEN, config);
    }
    if (!mountedRef.current) return;
    setEchogardenSttConfig(config);
  };

  const handleSetEchogardenSttConfig = async (
    config: EchogardenSttConfigType
  ) => {
    return EnjoyApp.userSettings
      .set(UserSettingKeyEnum.ECHOGARDEN, config)
      .then(() => {
        if (!mountedRef.current) return;
        setEchogardenSttConfig(config);
      });
  };

  const refreshPronunciationAssessmentConfig = async () => {
    let config = await EnjoyApp.userSettings.get(
      UserSettingKeyEnum.PRONUNCIATION_ASSESSMENT
    );

    if (!config) {
      const sttModel =
        echogardenSttConfig?.[
          echogardenSttConfig.engine.replace(".cpp", "Cpp") as
            | "whisper"
            | "whisperCpp"
        ]?.model || "tiny";

      config = {
        engine: isGuest
          ? PronunciationAssessmentEngineEnum.WHISPER_LOCAL
          : PronunciationAssessmentEngineEnum.AZURE,
        whisper: {
          engine: "whisper",
          model: sttModel,
        },
      } satisfies PronunciationAssessmentConfigType;

      await EnjoyApp.userSettings.set(
        UserSettingKeyEnum.PRONUNCIATION_ASSESSMENT,
        config
      );
    }

    if (
      isGuest &&
      ![
        PronunciationAssessmentEngineEnum.WHISPER_LOCAL,
        PronunciationAssessmentEngineEnum.SHERPA_WASM,
      ].includes(config?.engine)
    ) {
      config = {
        ...config,
        engine: PronunciationAssessmentEngineEnum.WHISPER_LOCAL,
      };
      await EnjoyApp.userSettings.set(
        UserSettingKeyEnum.PRONUNCIATION_ASSESSMENT,
        config
      );
    }

    if (config?.engine === PronunciationAssessmentEngineEnum.WHISPER_LOCAL) {
      const model = config.whisper?.model || "tiny";
      if (!WHISPER_MODELS.includes(model)) {
        config.whisper = {
          engine: config.whisper?.engine || "whisper",
          model: "tiny",
        };
      }
    }

    if (config?.engine === PronunciationAssessmentEngineEnum.SHERPA_WASM) {
      config.sherpa = config.sherpa || { modelId: "en-us-small" };
    }

    if (!mountedRef.current) return;
    setPronunciationAssessmentConfig(config);
  };

  const handleSetPronunciationAssessmentConfig = async (
    config: PronunciationAssessmentConfigType
  ) => {
    return EnjoyApp.userSettings
      .set(UserSettingKeyEnum.PRONUNCIATION_ASSESSMENT, config)
      .then(() => {
        if (!mountedRef.current) return;
        setPronunciationAssessmentConfig(config);
      });
  };

  useEffect(() => {
    refreshGptProviders();
    refreshTtsProviders();
  }, [openai, gptEngine, isGuest, webApi]);

  useEffect(() => {
    if (db.state !== "connected") return;

    let cancelled = false;
    (async () => {
      try {
        await fetchSettings(() => cancelled);
      } catch (error: any) {
        logger.warn(error?.message || error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [db.state, isGuest]);

  useEffect(() => {
    if (!isGuest) return;
    if ([SttEngineOptionEnum.LOCAL, SttEngineOptionEnum.OPENAI].includes(sttEngine))
      return;
    setSttEngine(SttEngineOptionEnum.LOCAL);
  }, [isGuest, sttEngine]);

  useEffect(() => {
    if (db.state !== "connected") return;
    if (!echogardenSttConfig) return;

    refreshPronunciationAssessmentConfig();
  }, [db.state, echogardenSttConfig, isGuest]);

  useEffect(() => {
    if (db.state !== "connected") return;
    if (!libraryPath) return;
  }, [db.state, libraryPath]);

  const handleSetSttEngine = async (name: SttEngineOptionEnum) => {
    if (isGuest && ![SttEngineOptionEnum.LOCAL, SttEngineOptionEnum.OPENAI].includes(name)) {
      name = SttEngineOptionEnum.LOCAL;
    }
    setSttEngine(name);
    return EnjoyApp.userSettings.set(UserSettingKeyEnum.STT_ENGINE, name);
  };

  const fetchSettings = async (isCancelled?: () => boolean) => {
    const _sttEngine = await EnjoyApp.userSettings.get(
      UserSettingKeyEnum.STT_ENGINE
    );
    if (isCancelled?.()) return;
    if (_sttEngine) {
      if (
        isGuest &&
        ![SttEngineOptionEnum.LOCAL, SttEngineOptionEnum.OPENAI].includes(
          _sttEngine
        )
      ) {
        setSttEngine(SttEngineOptionEnum.LOCAL);
        EnjoyApp.userSettings.set(
          UserSettingKeyEnum.STT_ENGINE,
          SttEngineOptionEnum.LOCAL
        );
      } else {
        setSttEngine(_sttEngine);
      }
    }

    const _openai = await EnjoyApp.userSettings.get(UserSettingKeyEnum.OPENAI);
    if (isCancelled?.()) return;
    if (_openai) {
      setOpenai(Object.assign({ name: "openai" }, _openai));
    }

    const _gptEngine = await EnjoyApp.userSettings.get(
      UserSettingKeyEnum.GPT_ENGINE
    );
    if (isCancelled?.()) return;
    if (_gptEngine) {
      if (isGuest && _gptEngine.name !== "openai") {
        const engine = {
          name: "openai",
          models: { default: "gpt-4o" },
        };
        EnjoyApp.userSettings.set(UserSettingKeyEnum.GPT_ENGINE, engine);
        setGptEngine(engine);
      } else {
        setGptEngine(_gptEngine);
      }
    } else if (_openai?.key) {
      const engine = {
        name: "openai",
        models: {
          default: "gpt-4o",
        },
      };
      EnjoyApp.userSettings
        .set(UserSettingKeyEnum.GPT_ENGINE, engine)
        .then(() => {
          if (isCancelled?.()) return;
          setGptEngine(engine);
        });
    } else {
      const engine = isGuest
        ? {
            name: "openai",
            models: { default: "gpt-4o" },
          }
        : {
            name: "enjoyai",
            models: { default: "gpt-4o" },
          };
      EnjoyApp.userSettings.set(UserSettingKeyEnum.GPT_ENGINE, engine).then(() => {
        if (isCancelled?.()) return;
        setGptEngine(engine);
      });
    }

    if (isCancelled?.()) return;
    await refreshEchogardenSttConfig();
    if (isCancelled?.()) return;
    await refreshTtsConfig();
  };

  const handleSetOpenai = async (config: LlmProviderType) => {
    await EnjoyApp.userSettings.set(UserSettingKeyEnum.OPENAI, config);
    setOpenai(Object.assign({ name: "openai" }, config));
  };

  return (
    <AISettingsProviderContext.Provider
      value={{
        setGptEngine: (engine: GptEngineSettingType) => {
          EnjoyApp.userSettings
            .set(UserSettingKeyEnum.GPT_ENGINE, engine)
            .then(() => {
              setGptEngine(engine);
            });
        },
        currentGptEngine:
          gptEngine?.name === "openai" || isGuest
            ? {
                ...gptEngine,
                name: "openai",
                key: openai?.key,
                baseUrl: openai?.baseUrl,
              }
            : {
                ...gptEngine,
                key: user?.accessToken,
                baseUrl: `${apiUrl}/api/ai`,
              },
        openai,
        setOpenai: (config: LlmProviderType) => handleSetOpenai(config),
        echogardenSttConfig,
        setEchogardenSttConfig: (config: EchogardenSttConfigType) =>
          handleSetEchogardenSttConfig(config),
        pronunciationAssessmentConfig,
        setPronunciationAssessmentConfig: (config: PronunciationAssessmentConfigType) =>
          handleSetPronunciationAssessmentConfig(config),
        sttEngine,
        setSttEngine: (name: SttEngineOptionEnum) => handleSetSttEngine(name),
        ttsConfig,
        setTtsConfig: (config: TtsConfigType) => handleSetTtsConfig(config),
        gptProviders,
        ttsProviders,
      }}
    >
      {children}
    </AISettingsProviderContext.Provider>
  );
};
