import { t } from "i18next";
import { AppSettingsProviderContext } from "@renderer/context";
import { useContext, useEffect, useState } from "react";
import { AppSettingsKeyEnum } from "@/types/enums";
import { Switch, Label, toast } from "@renderer/components/ui";

export const AudioSettings = () => {
    const { EnjoyApp } = useContext(AppSettingsProviderContext);
    const [enabled, setEnabled] = useState(false);

    useEffect(() => {
        EnjoyApp.appSettings
            .get(AppSettingsKeyEnum.AUDIO_PROCESSOR_ENABLE_DEEPFILTER)
            .then((value) => {
                setEnabled(Boolean(value));
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

    return (
        <div className="flex items-center justify-between py-4">
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
    );
};
