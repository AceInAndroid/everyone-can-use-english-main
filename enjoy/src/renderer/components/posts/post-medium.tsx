import { PostAudio } from "@renderer/components";
import { t } from "i18next";
import { MediaPlayer, MediaProvider, PlayerSrc } from "@vidstack/react";
import {
  DefaultVideoLayout,
  defaultLayoutIcons,
} from "@vidstack/react/player/layouts/default";
import { MIME_TYPES } from "@/constants";

export const PostMedium = (props: { medium: MediumType }) => {
  const { medium } = props;
  if (!medium.sourceUrl) return null;

  return (
    <div className="space-y-2">
      {medium.mediumType == "Video" && (
        <>
          <div className="text-xs text-muted-foreground">
            {t("sharedAudio")}
          </div>
          <MediaPlayer
            poster={medium.coverUrl}
            src={{
              src: medium.sourceUrl,
              type: getMediumMimeType(medium),
            } as PlayerSrc}
          >
            <MediaProvider />
            <DefaultVideoLayout icons={defaultLayoutIcons} />
          </MediaPlayer>
        </>
      )}

      {medium.mediumType == "Audio" && (
        <>
          <div className="text-xs text-muted-foreground">
            {t("sharedAudio")}
          </div>
          <PostAudio audio={medium} />
        </>
      )}
    </div>
  );
};

const normalizeExtension = (ext?: string) => {
  if (!ext) return "";
  const trimmed = ext.trim();
  if (!trimmed) return "";
  return trimmed.startsWith(".") ? trimmed.toLowerCase() : `.${trimmed.toLowerCase()}`;
};

const guessExtensionFromUrl = (url?: string) => {
  if (!url) return "";
  try {
    const match = url.match(/\.[a-zA-Z0-9]+(?=(?:[?#]|$))/);
    return match ? match[0].toLowerCase() : "";
  } catch {
    return "";
  }
};

const getMediumMimeType = (medium: MediumType) => {
  const ext =
    normalizeExtension(medium.extname) || guessExtensionFromUrl(medium.sourceUrl);
  if (ext && MIME_TYPES[ext]) {
    return MIME_TYPES[ext];
  }
  return medium.mediumType === "Audio" ? "audio/mpeg" : "video/mp4";
};
