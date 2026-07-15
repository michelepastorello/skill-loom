import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expandTilde, type ServedVia } from "./config.js";
import { UsageError } from "./errors.js";

// Two paths are the same directory once ~ is expanded and both are resolved.
function sameDir(a: string, b: string): boolean {
  return path.resolve(expandTilde(a)) === path.resolve(expandTilde(b));
}

// Indent width of the target file, so a rewrite matches its existing style.
function detectIndent(text: string): number {
  const m = /\n(\s+)\S/.exec(text);
  return m ? m[1].length : 2;
}

function readObj(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Is the vault currently registered in the served-via array? */
export function isServed(vaultDir: string, sv: ServedVia): boolean {
  const obj = readObj(expandTilde(sv.file));
  if (!obj) return false;
  let cur: unknown = obj;
  for (const key of sv.jsonPath.split(".")) {
    if (cur == null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  return (
    Array.isArray(cur) &&
    cur.some((d) => typeof d === "string" && sameDir(d, vaultDir))
  );
}

/** Add (on) or remove (off) the vault path in the served-via array, creating
 *  the nested path when turning on. Rewrites the file only when it changes. */
export function setServed(
  vaultDir: string,
  sv: ServedVia,
  on: boolean,
): { changed: boolean } {
  const file = expandTilde(sv.file);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "{}\n";
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    // Deactivating from an unparseable/foreign file is a safe no-op — there's
    // nothing to remove. Activating needs a valid object to write into.
    if (!on) return { changed: false };
    throw new UsageError(`${file} is not a valid JSON object`);
  }
  const parts = sv.jsonPath.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    if (next === undefined || next === null) {
      if (!on) return { changed: false }; // nothing to remove from
      cur[k] = {};
    } else if (typeof next !== "object" || Array.isArray(next)) {
      // Present but not a plain object — a hand-edited value we must not clobber.
      if (!on) return { changed: false };
      throw new UsageError(
        `${file}: "${parts.slice(0, i + 1).join(".")}" is not an object`,
      );
    }
    cur = cur[k] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  const existing = cur[leaf];
  if (existing === undefined || existing === null) {
    if (!on) return { changed: false };
    cur[leaf] = [];
  } else if (!Array.isArray(existing)) {
    if (!on) return { changed: false };
    throw new UsageError(`${file}: "${sv.jsonPath}" is not an array`);
  }
  const arr = cur[leaf] as string[];
  const idx = arr.findIndex(
    (d) => typeof d === "string" && sameDir(d, vaultDir),
  );
  let changed = false;
  if (on && idx < 0) {
    arr.push(path.resolve(expandTilde(vaultDir)));
    changed = true;
  } else if (!on && idx >= 0) {
    arr.splice(idx, 1);
    changed = true;
  }
  if (changed) {
    writeFileSync(file, JSON.stringify(obj, null, detectIndent(text)) + "\n");
  }
  return { changed };
}
