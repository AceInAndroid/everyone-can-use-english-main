import { ipcMain, IpcMainEvent } from "electron";
import {
  Recording,
  Audio,
  Video,
  PronunciationAssessment,
} from "@main/db/models";
import db from "@main/db";
import {
  FindOptions,
  WhereOptions,
  Attributes,
  Sequelize,
  Op,
} from "sequelize";
import dayjs from "dayjs";
import { t } from "i18next";
import log from "@main/logger";
import { NIL as NIL_UUID } from "uuid";
import FfmpegWrapper from "@main/ffmpeg";
import path from "path";
import settings from "@main/settings";
import { enjoyUrlToPath, pathToEnjoyUrl } from "@main/utils";

const logger = log.scope("db/handlers/recordings-handler");

class RecordingsHandler {
  private async findAll(
    event: IpcMainEvent,
    options: FindOptions<Attributes<Recording>>
  ) {
    try {
      const recordings = await db.withRetry(() =>
        Recording.scope("withoutDeleted").findAll({
          include: PronunciationAssessment,
          order: [["createdAt", "DESC"]],
          ...options,
        })
      );

      if (!recordings) return [];
      return recordings.map((recording) => recording.toJSON());
    } catch (err: any) {
      event.sender.send("on-notification", {
        type: "error",
        message: err.message,
      });
      return [];
    }
  }

  private async findOne(_event: IpcMainEvent, where: WhereOptions<Recording>) {
    const recording = await db.withRetry(() =>
      Recording.scope("withoutDeleted").findOne({
        include: PronunciationAssessment,
        order: [["createdAt", "DESC"]],
        where: {
          ...where,
        },
      })
    );
    if (!recording) {
      throw new Error(t("models.recording.notFound"));
    }
    if (!recording.isSynced) {
      recording.sync().catch(() => {});
    }

    return recording.toJSON();
  }

  private async sync(_event: IpcMainEvent, id: string) {
    const recording = await db.withRetry(() =>
      Recording.findOne({
        where: {
          id,
        },
      })
    );

    if (!recording) {
      throw new Error(t("models.recording.notFound"));
    }

    return await recording.sync();
  }

  private async syncAll(event: IpcMainEvent) {
    const recordings = await db.withRetry(() =>
      Recording.findAll({
        where: { syncedAt: null },
      })
    );
    if (recordings.length == 0) return;

    event.sender.send("on-notification", {
      type: "warning",
      message: t("syncingRecordings", { count: recordings.length }),
    });

    try {
      await Promise.all(
        recordings.map((recording) => db.withRetry(() => recording.sync()))
      );
    } catch (err) {
      logger.error("failed to sync recordings", err.message);

      event.sender.send("on-notification", {
        type: "error",
        message: t("failedToSyncRecordings"),
      });
    }
  }

  private async create(
    _event: IpcMainEvent,
    options: Attributes<Recording> & {
      blob: {
        type: string;
        arrayBuffer: ArrayBuffer;
      };
    }
  ) {
    const {
      targetId = NIL_UUID,
      targetType = "None",
      referenceId,
      referenceText,
      duration,
    } = options;
    const recording = await db.withRetry(() =>
      Recording.createFromBlob(options.blob, {
        targetId,
        targetType,
        referenceId,
        referenceText,
        duration,
      })
    );
    if (!recording) {
      throw new Error(t("models.recording.failedToSave"));
    }
    return recording.toJSON();
  }

  private async destroy(_event: IpcMainEvent, id: string) {
    const recording = await db.withRetry(() =>
      Recording.scope("withoutDeleted").findOne({
        where: {
          id,
        },
      })
    );

    if (!recording) {
      throw new Error(t("models.recording.notFound"));
    }

    await db.withRetry(() => recording.softDelete());
  }

  private async destroyBulk(
    _event: IpcMainEvent,
    where: WhereOptions<Recording> & { ids: string[] }
  ) {
    if (where.ids) {
      where = {
        ...where,
        id: {
          [Op.in]: where.ids,
        },
      };
    }
    delete where.ids;

    const recordings = await db.withRetry(() =>
      Recording.scope("withoutDeleted").findAll({
        where,
      })
    );
    if (recordings.length === 0) {
      return;
    }
    for (const recording of recordings) {
      await db.withRetry(() => recording.softDelete());
    }
  }

  private async upload(_event: IpcMainEvent, id: string) {
    const recording = await db.withRetry(() =>
      Recording.scope("withoutDeleted").findOne({
        where: {
          id,
        },
      })
    );

    if (!recording) {
      throw new Error(t("models.recording.notFound"));
    }

    return await recording.upload();
  }

  private async stats(
    event: IpcMainEvent,
    options: { from: string; to: string }
  ) {
    const { from, to } = options;
    const where: WhereOptions = {};
    if (from && to) {
      where.createdAt = {
        [Op.between]: [from, to],
      };
    }

    try {
      const stats = await db.withRetry(() =>
        Recording.findOne({
          attributes: [
            [Sequelize.fn("count", Sequelize.col("id")), "count"],
            [
              Sequelize.fn("SUM", Sequelize.col("recording.duration")),
              "duration",
            ],
          ],
          where,
        })
      );

      if (!stats) return [];
      return stats.toJSON();
    } catch (err: any) {
      event.sender.send("on-notification", {
        type: "error",
        message: err.message,
      });
      return [];
    }
  }

  private async groupByDate(
    event: IpcMainEvent,
    options: { from: string; to: string }
  ) {
    const { from, to } = options;

    try {
      const recordings = await db.withRetry(() =>
        Recording.findAll({
          attributes: [
            [Sequelize.fn("DATE", Sequelize.col("created_at")), "date"],
            [Sequelize.fn("count", Sequelize.col("id")), "count"],
          ],
          group: ["date"],
          order: [["date", "ASC"]],
          where: {
            createdAt: {
              [Op.between]: [from, to],
            },
          },
        })
      );

      if (!recordings) return [];
      return recordings.map((recording) => recording.toJSON());
    } catch (err: any) {
      event.sender.send("on-notification", {
        type: "error",
        message: err.message,
      });
      return [];
    }
  }

  private async groupByTarget(
    event: IpcMainEvent,
    options: { from: string; to: string }
  ) {
    // query last 7 days by default
    const {
      from = dayjs().subtract(7, "day").format(),
      to = dayjs().format(),
    } = options;

    try {
      const recordings = await db.withRetry(() =>
        Recording.findAll({
          include: [
            {
              model: Audio,
              attributes: ["name", "id"],
            },
            {
              model: Video,
              attributes: ["name", "id"],
            },
          ],
          attributes: [
            "targetId",
            "targetType",
            [Sequelize.fn("DATE", Sequelize.col("recording.created_at")), "date"],
            [Sequelize.fn("COUNT", Sequelize.col("recording.id")), "count"],
            [Sequelize.fn("SUM", Sequelize.col("recording.duration")), "duration"],
          ],
          group: ["date", "target_id", "target_type"],
          order: [
            ["date", "DESC"],
            ["count", "DESC"],
          ],
          where: {
            createdAt: {
              [Op.between]: [from, to],
            },
          },
        })
      );

      if (!recordings) return [];
      return recordings.map((recording) => recording.toJSON());
    } catch (err: any) {
      event.sender.send("on-notification", {
        type: "error",
        message: err.message,
      });
      return [];
    }
  }

  private async groupBySegment(
    event: IpcMainEvent,
    targetId: string,
    targetType: string
  ) {
    try {
      const stats = await db.withRetry(() =>
        Recording.findAll({
          where: {
            targetId,
            targetType,
          },
          include: [
            {
              model: PronunciationAssessment,
              attributes: [
                [
                  Sequelize.fn("MAX", Sequelize.col("pronunciation_score")),
                  "pronunciationScore",
                ],
              ],
            },
          ],
          attributes: [
            "targetId",
            "targetType",
            "referenceId",
            "referenceText",
            [Sequelize.fn("COUNT", Sequelize.col("reference_id")), "count"],
            [Sequelize.fn("SUM", Sequelize.col("duration")), "duration"],
          ],
          group: ["referenceId"],
          order: [["referenceId", "ASC"]],
        })
      );

      if (!stats) return [];
      return stats.map((stat) => stat.toJSON());
    } catch (err: any) {
      event.sender.send("on-notification", {
        type: "error",
        message: err.message,
      });
      return [];
    }
  }

  private async statsForDeleteBulk() {
    // all recordings
    const recordings = await db.withRetry(() =>
      Recording.scope("withoutDeleted").findAll({
        include: PronunciationAssessment,
        order: [["createdAt", "DESC"]],
      })
    );
    // no assessment
    const noAssessment = recordings.filter((r) => !r.pronunciationAssessment);
    // score less than 90
    const scoreLessThan90 = recordings.filter(
      (r) =>
        !r.pronunciationAssessment ||
        r.pronunciationAssessment?.pronunciationScore < 90
    );
    // score less than 80
    const scoreLessThan80 = recordings.filter(
      (r) =>
        !r.pronunciationAssessment ||
        r.pronunciationAssessment?.pronunciationScore < 80
    );

    return {
      noAssessment: noAssessment.map((r) => r.id),
      scoreLessThan90: scoreLessThan90.map((r) => r.id),
      scoreLessThan80: scoreLessThan80.map((r) => r.id),
      all: recordings.map((r) => r.id),
    };
  }

  // Select the highest score of the recordings of each referenceId from the
  // recordings of the target and export as a single file.
  private async export(
    _event: IpcMainEvent,
    targetId: string,
    targetType: string
  ) {
    let target: Audio | Video;
    if (targetType === "Audio") {
      target = await db.withRetry(() =>
        Audio.findOne({
          where: {
            id: targetId,
          },
        })
      );
    } else {
      target = await db.withRetry(() =>
        Video.findOne({
          where: {
            id: targetId,
          },
        })
      );
    }

    if (!target) {
      throw new Error(t("models.recording.notFound"));
    }

    // query all recordings of the target
    const recordings = await db.withRetry(() =>
      Recording.scope("withoutDeleted").findAll({
        where: {
          targetId,
          targetType,
        },
        include: [
          {
            model: PronunciationAssessment,
            attributes: [
              [
                Sequelize.fn("MAX", Sequelize.col("pronunciation_score")),
                "pronunciationScore",
              ],
            ],
          },
        ],
        group: ["referenceId"],
        order: [["referenceId", "ASC"]],
      })
    );

    if (!recordings || recordings.length === 0) {
      throw new Error(t("models.recording.notFound"));
    }

    // export the recordings to a single file
    // using ffmpeg concat
    const ffmpeg = new FfmpegWrapper();
    const outputFilePath = path.join(
      settings.cachePath(),
      `${targetType}-${target.id}.mp3`
    );
    const inputFiles = recordings.map((recording) =>
      enjoyUrlToPath(recording.src)
    );
    await ffmpeg.concat(inputFiles, outputFilePath);
    return pathToEnjoyUrl(outputFilePath);
  }

  register() {
    ipcMain.handle("recordings-find-all", this.findAll.bind(this));
    ipcMain.handle("recordings-find-one", this.findOne.bind(this));
    ipcMain.handle("recordings-sync", this.sync.bind(this));
    ipcMain.handle("recordings-sync-all", this.syncAll.bind(this));
    ipcMain.handle("recordings-create", this.create.bind(this));
    ipcMain.handle("recordings-destroy", this.destroy.bind(this));
    ipcMain.handle("recordings-destroy-bulk", this.destroyBulk.bind(this));
    ipcMain.handle("recordings-upload", this.upload.bind(this));
    ipcMain.handle("recordings-stats", this.stats.bind(this));
    ipcMain.handle("recordings-group-by-date", this.groupByDate.bind(this));
    ipcMain.handle("recordings-group-by-target", this.groupByTarget.bind(this));
    ipcMain.handle("recordings-group-by-segment", this.groupBySegment.bind(this));
    ipcMain.handle(
      "recordings-stats-for-delete-bulk",
      this.statsForDeleteBulk.bind(this)
    );
    ipcMain.handle("recordings-export", this.export.bind(this));
  }

  unregister() {
    ipcMain.removeHandler("recordings-find-all");
    ipcMain.removeHandler("recordings-find-one");
    ipcMain.removeHandler("recordings-sync");
    ipcMain.removeHandler("recordings-sync-all");
    ipcMain.removeHandler("recordings-create");
    ipcMain.removeHandler("recordings-destroy");
    ipcMain.removeHandler("recordings-destroy-bulk");
    ipcMain.removeHandler("recordings-upload");
    ipcMain.removeHandler("recordings-stats");
    ipcMain.removeHandler("recordings-group-by-date");
    ipcMain.removeHandler("recordings-group-by-target");
    ipcMain.removeHandler("recordings-group-by-segment");
    ipcMain.removeHandler("recordings-stats-for-delete-bulk");
    ipcMain.removeHandler("recordings-export");
  }
}

export const recordingsHandler = new RecordingsHandler();
