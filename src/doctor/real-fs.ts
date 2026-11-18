import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { DoctorFs } from "./config-files.js";

const MAX_CONFIG_BYTES = 4 << 20;

/** The computer this process runs on. */
export function realDoctorFs(): DoctorFs {
  return {
    platform: process.platform,
    home: homedir(),
    cwd: process.cwd(),
    appData: process.env.APPDATA ?? "",
    xdgConfig: process.env.XDG_CONFIG_HOME ?? "",
    readText(path) {
      try {
        if (statSync(path).size > MAX_CONFIG_BYTES) return undefined;
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    isExecutable(path) {
      try {
        if (!statSync(path).isFile()) return false;
        if (process.platform !== "win32") accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
  };
}
