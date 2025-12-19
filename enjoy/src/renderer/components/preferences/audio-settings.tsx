import { t } from "i18next";
import { AppSettingsProviderContext } from "@renderer/context";
import { useContext, useEffect, useState, type FocusEventHandler } from "react";
import { AppSettingsKeyEnum } from "@/types/enums";
import { Switch, Label, Input, Button, toast } from "@renderer/components/ui";

export const AudioSettings = () => {
    const { EnjoyApp } = useContext(AppSettingsProviderContext);
    const [enabled, setEnabled] = useState(false);
    const [binaryPath, setBinaryPath] = useState("");
    const [savingPath, setSavingPath] = useState(false);

    useEffect(() => {
        const loadSettings = async () => {
            const [enabledValue, savedPath] = await Promise.all([
                EnjoyApp.appSettings.get(AppSettingsKeyEnum.AUDIO_PROCESSOR_ENABLE_DEEPFILTER),
                EnjoyApp.appSettings.get(AppSettingsKeyEnum.AUDIO_PROCESSOR_DEEPFILTER_PATH),
            ]);
            setEnabled(Boolean(enabledValue));
            setBinaryPath((savedPath as string) || "");
        };

        loadSettings();
    }, [EnjoyApp]);

    const persistBinaryPath = async (value: string) => {
        setSavingPath(true);
        try {
            await EnjoyApp.appSettings.set(
                AppSettingsKeyEnum.AUDIO_PROCESSOR_DEEPFILTER_PATH,
                value || null
            );
            toast.success(t("saved"));
        } catch (err: any) {
            toast.error(err.message);
        } finally {
            setSavingPath(false);
        }
    };

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

    const handlePathBlur: FocusEventHandler<HTMLInputElement> = (event) => {
        const raw = event.target.value;
        const next = raw.trim();
        if (next === binaryPath.trim()) {
            if (next !== binaryPath) {
                setBinaryPath(next);
            }
            return;
        }
        setBinaryPath(next);
        persistBinaryPath(next);
    };

    const handleChooseBinary = async () => {
        const filePaths = await EnjoyApp.dialog.showOpenDialog({
            properties: ["openFile"],
        });
        const selected = filePaths?.[0];
        if (selected) {
            setBinaryPath(selected);
            persistBinaryPath(selected);
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

            <div className="space-y-2">
                <Label htmlFor="audio-deepfilter-path" className="font-medium leading-none">
                    {t("deepFilterBinaryPath")}
                </Label>
                <div className="flex gap-2">
                    <Input
                        id="audio-deepfilter-path"
                        value={binaryPath}
                        onChange={(event) => setBinaryPath(event.target.value)}
                        onBlur={handlePathBlur}
                        placeholder="/usr/local/bin/deep-filter"
                        disabled={savingPath}
                    />
                    <Button variant="secondary" size="sm" onClick={handleChooseBinary} disabled={savingPath}>
                        {t("chooseExecutable")}
                    </Button>
                </div>
                <div className="text-sm text-muted-foreground">
                    {t("deepFilterBinaryPathDescription")}
                </div>
            </div>
        </div>
    );
};
