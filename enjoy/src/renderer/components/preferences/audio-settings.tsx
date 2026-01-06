import { t } from "i18next";
import { AppSettingsProviderContext } from "@renderer/context";
import { useContext, useEffect, useState } from "react";
import { AppSettingsKeyEnum } from "@/types/enums";
import { Switch, Label, toast, Input, Button } from "@renderer/components/ui";

export const AudioSettings = () => {
    const { EnjoyApp } = useContext(AppSettingsProviderContext);
    const [enabled, setEnabled] = useState(false);
    const [binaryPath, setBinaryPath] = useState("");
    const [savingPath, setSavingPath] = useState(false);

    useEffect(() => {
        EnjoyApp.appSettings
            .get(AppSettingsKeyEnum.AUDIO_PROCESSOR_ENABLE_DEEPFILTER)
            .then((value) => {
                setEnabled(Boolean(value));
            });

        EnjoyApp.appSettings
            .get(AppSettingsKeyEnum.AUDIO_PROCESSOR_DEEPFILTER_PATH)
            .then((value) => {
                setBinaryPath(value || "");
            });
    }, []);

    const handleCheckedChange = (value: boolean) => {
        EnjoyApp.appSettings
            .set(AppSettingsKeyEnum.AUDIO_PROCESSOR_ENABLE_DEEPFILTER, value)
            .then(() => {
                setEnabled(value);
                toast.success(t("saved"));
            })
            .catch((err) => {
                toast.error(err.message);
            });
    };

    const persistBinaryPath = async (value: string) => {
        setSavingPath(true);
        const normalized = value?.trim() || "";
        try {
            await EnjoyApp.appSettings.set(
                AppSettingsKeyEnum.AUDIO_PROCESSOR_DEEPFILTER_PATH,
                normalized || null
            );
            setBinaryPath(normalized);
            toast.success(t("saved"));
        } catch (err) {
            toast.error(err.message);
        } finally {
            setSavingPath(false);
        }
    };

    const handleChooseBinaryPath = async () => {
        const filePaths = await EnjoyApp.dialog.showOpenDialog({
            properties: ["openFile"],
        });
        if (filePaths && filePaths.length > 0) {
            await persistBinaryPath(filePaths[0]);
        }
    };

    return (
        <div className="space-y-4 py-4">
            <div className="flex items-center justify-between">
                <div className="flex flex-col space-y-1">
                    <Label htmlFor="audio-deepfilter-mode" className="font-medium leading-none mb-2">
                        {t("enableDeepFilterNet")}
                    </Label>
                    <div className="text-sm text-muted-foreground">
                        {t("enableDeepFilterNetDescription")}
                    </div>
                </div>
                <Switch
                    id="audio-deepfilter-mode"
                    checked={enabled}
                    onCheckedChange={handleCheckedChange}
                />
            </div>

            <div className="flex flex-col space-y-1">
                <Label htmlFor="audio-deepfilter-mode" className="font-medium leading-none mb-2">
                    {t("deepFilterBinaryPath")}
                </Label>
                <div className="text-sm text-muted-foreground">
                    {t("deepFilterBinaryPathDescription")}
                </div>
            </div>
            <div className="space-y-2">
                <Input
                    value={binaryPath}
                    placeholder={t("deepFilterBinaryPathPlaceholder")}
                    onChange={(event) => setBinaryPath(event.target.value)}
                />
                <div className="flex justify-end gap-2">
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={handleChooseBinaryPath}
                    >
                        {t("chooseFile")}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => persistBinaryPath("")}
                        disabled={savingPath}
                    >
                        {t("clear")}
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        onClick={() => persistBinaryPath(binaryPath)}
                        disabled={savingPath}
                    >
                        {t("save")}
                    </Button>
                </div>
            </div>
        </div>
    );
};
