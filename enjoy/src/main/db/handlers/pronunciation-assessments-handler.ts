import { ipcMain, IpcMainEvent } from "electron";
import { PronunciationAssessment, Recording } from "@main/db/models";
import { Attributes, FindOptions, WhereOptions } from "sequelize";
import db from "@main/db";

class PronunciationAssessmentsHandler {
  private async findAll(
    _event: IpcMainEvent,
    options: FindOptions<Attributes<PronunciationAssessment>>
  ) {
    const assessments = await db.withRetry(() =>
      PronunciationAssessment.findAll({
        include: [
          {
            association: "recording",
            model: Recording,
            required: false,
          },
        ],
        order: [["createdAt", "DESC"]],
        ...options,
      })
    );

    if (!assessments) {
      return [];
    }
    return assessments.map((assessment) => assessment.toJSON());
  }

  private async findOne(
    _event: IpcMainEvent,
    where: WhereOptions<PronunciationAssessment>
  ) {
    const assessment = await db.withRetry(() =>
      PronunciationAssessment.findOne({
        where: {
          ...where,
        },
        include: [
          {
            association: "recording",
            model: Recording,
            required: false,
          },
        ],
      })
    );

    return assessment.toJSON();
  }

  private async create(
    _event: IpcMainEvent,
    data: Partial<Attributes<PronunciationAssessment>>
  ) {
    const { targetId, targetType } = data;
    const existed = await db.withRetry(() =>
      PronunciationAssessment.findOne({
        where: {
          targetId,
          targetType,
        },
      })
    );

    if (existed) {
      return existed.toJSON();
    }

    const assessment = await db.withRetry(() => PronunciationAssessment.create(data));
    return assessment.toJSON();
  }

  private async update(
    _event: IpcMainEvent,
    id: string,
    data: Attributes<PronunciationAssessment>
  ) {
    const assessment = await db.withRetry(() =>
      PronunciationAssessment.findOne({
        where: { id: id },
      })
    );

    if (!assessment) {
      throw new Error("Assessment not found");
    }

    await db.withRetry(() => assessment.update(data));
  }

  private async destroy(_event: IpcMainEvent, id: string) {
    const assessment = await db.withRetry(() =>
      PronunciationAssessment.findOne({
        where: {
          id,
        },
      })
    );

    if (!assessment) {
      throw new Error("Assessment not found");
    }

    await db.withRetry(() => assessment.destroy());
  }

  register() {
    ipcMain.handle(
      "pronunciation-assessments-find-all",
      this.findAll.bind(this)
    );
    ipcMain.handle(
      "pronunciation-assessments-find-one",
      this.findOne.bind(this)
    );
    ipcMain.handle(
      "pronunciation-assessments-create",
      this.create.bind(this)
    );
    ipcMain.handle(
      "pronunciation-assessments-update",
      this.update.bind(this)
    );
    ipcMain.handle(
      "pronunciation-assessments-destroy",
      this.destroy.bind(this)
    );
  }

  unregister() {
    ipcMain.removeHandler("pronunciation-assessments-find-all");
    ipcMain.removeHandler("pronunciation-assessments-find-one");
    ipcMain.removeHandler("pronunciation-assessments-create");
    ipcMain.removeHandler("pronunciation-assessments-update");
    ipcMain.removeHandler("pronunciation-assessments-destroy");
  }
}

export const pronunciationAssessmentsHandler =
  new PronunciationAssessmentsHandler();
