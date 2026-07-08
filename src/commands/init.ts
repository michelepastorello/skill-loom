import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_NAME,
  DEFAULT_IGNORE,
  expandTilde,
  saveConfig,
  type LoomConfig,
} from "../config.js";
import { ARCHIVE_DIR } from "../vault.js";

export const PRESETS: Record<string, string> = {
  claude: "~/.claude/skills",
  codex: "~/.agents/skills",
};

export function runInit(vaultDir: string): number {
  if (existsSync(path.join(vaultDir, CONFIG_NAME))) {
    console.error(`${CONFIG_NAME} already exists in ${vaultDir}`);
    return 2;
  }
  const consumers: Record<string, string> = {};
  for (const [name, dir] of Object.entries(PRESETS)) {
    if (existsSync(path.dirname(expandTilde(dir)))) consumers[name] = dir;
  }
  const cfg: LoomConfig = {
    schema: 1,
    consumers,
    ignore: [...DEFAULT_IGNORE],
    archived: [],
  };
  saveConfig(vaultDir, cfg);
  mkdirSync(path.join(vaultDir, ARCHIVE_DIR), { recursive: true });
  console.log(`initialized vault in ${vaultDir}`);
  const detected = Object.keys(consumers).join(", ");
  console.log(
    detected
      ? `detected consumers: ${detected}`
      : `no consumers detected — add them to ${CONFIG_NAME}`,
  );
  return 0;
}
