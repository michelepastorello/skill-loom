import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";

export interface ArchivedEntry {
  name: string;
  date: string;
  reason: string;
}

export interface LoomConfig {
  schema: 1;
  consumers: Record<string, string>;
  ignore: string[];
  archived: ArchivedEntry[];
}

export const CONFIG_NAME = "loom.json";
export const DEFAULT_IGNORE = [".git", "node_modules", "__pycache__", ".venv"];

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function loadConfig(vaultDir: string): LoomConfig {
  const file = path.join(vaultDir, CONFIG_NAME);
  if (!existsSync(file)) {
    throw new UsageError(
      `no ${CONFIG_NAME} in ${vaultDir} — run "skill-loom init" first`,
    );
  }
  let raw: Partial<LoomConfig>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Partial<LoomConfig>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`invalid ${CONFIG_NAME} in ${vaultDir}: ${message}`);
  }
  return {
    schema: 1,
    consumers: raw.consumers ?? {},
    ignore: raw.ignore ?? [...DEFAULT_IGNORE],
    archived: raw.archived ?? [],
  };
}

export function saveConfig(vaultDir: string, cfg: LoomConfig): void {
  writeFileSync(
    path.join(vaultDir, CONFIG_NAME),
    JSON.stringify(cfg, null, 2) + "\n",
  );
}
