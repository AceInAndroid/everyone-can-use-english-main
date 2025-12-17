import { ipcMain, IpcMainEvent } from "electron";
import { UserSetting } from "@main/db/models";
import db from "@main/db";
import { UserSettingKeyEnum } from "@/types/enums";

class UserSettingsHandler {
  private async ensureDbReady() {
    if (db.isConnecting) {
      await new Promise<void>((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (!db.isConnecting) return resolve();
          if (Date.now() - start > 15_000) return resolve();
          setTimeout(tick, 100);
        };
        tick();
      });
    }

    if (!db.connection) {
      await db.connect();
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.ensureDbReady();
      return await fn();
    } catch (error: any) {
      const message = String(error?.message || error);
      const shouldRetry =
        message.includes("SQLITE_MISUSE") ||
        message.includes("Database handle is closed");

      if (!shouldRetry) throw error;

      try {
        await db.disconnect();
      } catch {
        // ignore
      }

      await this.ensureDbReady();
      return await fn();
    }
  }

  private async get(_event: IpcMainEvent, key: UserSettingKeyEnum) {
    return await this.withRetry(() => UserSetting.get(key));
  }

  private async set(
    _event: IpcMainEvent,
    key: UserSettingKeyEnum,
    value: string | object
  ) {
    await this.withRetry(() => UserSetting.set(key, value).then(() => undefined));
  }

  private async delete(_event: IpcMainEvent, key: UserSettingKeyEnum) {
    await this.withRetry(() => UserSetting.destroy({ where: { key } }).then(() => undefined));
  }

  private async clear(_event: IpcMainEvent) {
    await this.withRetry(async () => {
      await UserSetting.destroy({ where: {} });
      await db.connection?.query("VACUUM");
      return undefined;
    });
  }

  register() {
    ipcMain.handle("user-settings-get", this.get.bind(this));
    ipcMain.handle("user-settings-set", this.set.bind(this));
    ipcMain.handle("user-settings-delete", this.delete.bind(this));
    ipcMain.handle("user-settings-clear", this.clear.bind(this));
  }

  unregister() {
    ipcMain.removeHandler("user-settings-get");
    ipcMain.removeHandler("user-settings-set");
    ipcMain.removeHandler("user-settings-delete");
    ipcMain.removeHandler("user-settings-clear");
  }
}

export const userSettingsHandler = new UserSettingsHandler();
