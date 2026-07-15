import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";

/** Optional content gate. Every field is opt-in: an absent block leaves doctor
 *  with only its built-in hygiene warnings. `strict` turns every finding into
 *  an exit-code failure, so a vault can enforce its own conventions in CI. */
export interface LintConfig {
  strict?: boolean;
  descriptionMinChars?: number;
  descriptionMaxChars?: number;
  bodyMaxLines?: number;
  requireSections?: string[];
  requireTaxonomy?: string[];
  allowedDomains?: string[];
  allowedLayers?: string[];
  forbidBodyPatterns?: string[];
}

export type ConsumerMode = "symlink" | "in-place";

/** For an in-place consumer, where the vault path is registered so the runtime
 *  reads it (e.g. OpenClaw's `skills.load.extraDirs`). Lets the dashboard toggle
 *  activation on/off by editing that array — no symlinks involved. Generic: any
 *  JSON file + dot-path to an array of directories. */
export interface ServedVia {
  file: string;
  jsonPath: string;
}

/** A consumer value in loom.json. A bare string is a symlink consumer (a skills
 *  directory to link into — the default). An object can pin the mode: `in-place`
 *  is a runtime that reads the vault directly through its own config (e.g.
 *  OpenClaw's `skills.load.extraDirs`), so skill-loom never symlinks into it. */
export type ConsumerValue =
  | string
  | {
      mode?: ConsumerMode;
      path?: string;
      note?: string;
      servedVia?: ServedVia;
    };

export interface LoomConfig {
  schema: 1;
  consumers: Record<string, ConsumerValue>;
  ignore: string[];
  /** Custom word casing for humanized names/labels: kebab word → cased form
   *  (e.g. { "forpros": "ForPros" }). Merged over the built-in dictionaries. */
  names: Record<string, string>;
  lint?: LintConfig;
}

/** A consumer resolved to a uniform shape. `dir` is the expanded skills
 *  directory for symlink consumers, and `null` for in-place ones (which have no
 *  managed directory — the runtime reads the vault itself). */
export interface Consumer {
  name: string;
  mode: ConsumerMode;
  dir: string | null;
  note?: string;
  servedVia?: ServedVia;
}

export function resolveConsumers(cfg: LoomConfig): Consumer[] {
  return Object.entries(cfg.consumers).map(([name, value]) => {
    if (typeof value === "string") {
      return { name, mode: "symlink", dir: expandTilde(value) };
    }
    const mode: ConsumerMode = value.mode ?? "symlink";
    return {
      name,
      mode,
      dir: mode === "symlink" && value.path ? expandTilde(value.path) : null,
      ...(value.note ? { note: value.note } : {}),
      ...(value.servedVia ? { servedVia: value.servedVia } : {}),
    };
  });
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(`invalid ${CONFIG_NAME} in ${vaultDir}: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError(
      `invalid ${CONFIG_NAME} in ${vaultDir}: expected a JSON object`,
    );
  }
  const raw = parsed as Partial<LoomConfig>;
  const warn = (m: string) => console.error(`warning: ${CONFIG_NAME}: ${m}`);

  // Consumers: keep only well-formed entries. A bad one (empty path, wrong
  // type) is dropped with a warning so it can never silently create a stray
  // symlink in the process CWD — the command still runs for the valid rest.
  const consumers: Record<string, ConsumerValue> = {};
  if (raw.consumers !== undefined) {
    if (
      typeof raw.consumers !== "object" ||
      raw.consumers === null ||
      Array.isArray(raw.consumers)
    ) {
      warn("consumers must be an object — ignoring it");
    } else {
      for (const [name, value] of Object.entries(raw.consumers)) {
        if (typeof value === "string") {
          if (value.trim()) consumers[name] = value;
          else warn(`consumer "${name}" has an empty path — ignoring it`);
        } else if (
          value &&
          typeof value === "object" &&
          !Array.isArray(value)
        ) {
          const v = value as { mode?: string; path?: string };
          if (
            v.mode === "in-place" ||
            (typeof v.path === "string" && v.path.trim())
          ) {
            consumers[name] = value as ConsumerValue;
          } else {
            warn(
              `consumer "${name}" is neither in-place nor has a path — ignoring it`,
            );
          }
        } else {
          warn(`consumer "${name}" has an invalid value — ignoring it`);
        }
      }
    }
  }

  let ignore = [...DEFAULT_IGNORE];
  if (raw.ignore !== undefined) {
    if (
      Array.isArray(raw.ignore) &&
      raw.ignore.every((x) => typeof x === "string")
    ) {
      ignore = raw.ignore;
    } else {
      warn("ignore must be an array of strings — using the default");
    }
  }

  let names: Record<string, string> = {};
  if (raw.names !== undefined) {
    if (
      typeof raw.names === "object" &&
      raw.names !== null &&
      !Array.isArray(raw.names)
    ) {
      names = raw.names;
    } else {
      warn("names must be an object — ignoring it");
    }
  }

  // A lint block that isn't an object is silently ignored by the rest of the
  // code (the gate just sees no fields), quietly disabling the rules you wrote —
  // so that's a hard error. Semantic problems inside a valid lint object (e.g. a
  // bad forbidBodyPatterns regex) are surfaced by `doctor` as findings, so we
  // don't re-validate them here and steal that report.
  if (
    raw.lint !== undefined &&
    (typeof raw.lint !== "object" ||
      raw.lint === null ||
      Array.isArray(raw.lint))
  ) {
    throw new UsageError(
      `invalid ${CONFIG_NAME} in ${vaultDir}: lint must be an object`,
    );
  }

  return {
    schema: 1,
    consumers,
    ignore,
    names,
    ...(raw.lint ? { lint: raw.lint } : {}),
  };
}

/** Recursively sort object keys alphabetically, leaving array *element* order
 *  intact (ignore / forbidBodyPatterns / requireTaxonomy are order-independent
 *  sets, not lists to alphabetize element-wise). Used by saveConfig so every
 *  level below the semantic top-level order is canonical and diffs stay stable. */
export function deepSortKeys<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => deepSortKeys(x)) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, deepSortKeys(val)]),
    ) as T;
  }
  return v;
}

// The lint block reads best in a semantic order (taxonomy rules → sections →
// length → body patterns → the strict flag), not alphabetically. This is the
// same order the Rules editor and normalizedLint use in the UI, so the on-disk
// file matches what the user edits. Unknown/future keys are appended, sorted.
const LINT_KEY_ORDER = [
  "requireTaxonomy",
  "allowedDomains",
  "allowedLayers",
  "requireSections",
  "descriptionMinChars",
  "descriptionMaxChars",
  "bodyMaxLines",
  "forbidBodyPatterns",
  "strict",
];

export function saveConfig(vaultDir: string, cfg: LoomConfig): void {
  // Canonical form: the top-level key order is preserved as loaded (never
  // reshuffled behind the user). Below it, keys are sorted alphabetically
  // (deepSortKeys) EXCEPT the lint block, whose keys keep LINT_KEY_ORDER's
  // semantic order. Lint's set-lists (domains/layers/sections) are alphabetized;
  // other array element order is preserved. Additions land predictably.
  const sortArr = (a?: string[]): string[] | undefined =>
    a ? [...a].sort((x, y) => x.localeCompare(y)) : a;
  let lint: Record<string, unknown> | undefined;
  if (cfg.lint) {
    const sorted: Record<string, unknown> = {
      ...cfg.lint,
      ...(cfg.lint.allowedDomains
        ? { allowedDomains: sortArr(cfg.lint.allowedDomains) }
        : {}),
      ...(cfg.lint.allowedLayers
        ? { allowedLayers: sortArr(cfg.lint.allowedLayers) }
        : {}),
      ...(cfg.lint.requireSections
        ? { requireSections: sortArr(cfg.lint.requireSections) }
        : {}),
    };
    const known = LINT_KEY_ORDER.filter((k) => k in sorted);
    const extra = Object.keys(sorted)
      .filter((k) => !LINT_KEY_ORDER.includes(k))
      .sort();
    lint = Object.fromEntries([...known, ...extra].map((k) => [k, sorted[k]]));
  }
  const staged = { ...cfg, ...(lint ? { lint } : {}) };
  const out = Object.fromEntries(
    Object.entries(staged).map(([k, v]) =>
      // lint keeps its semantic key order; deepSortKeys would re-alphabetize it.
      k === "lint" ? [k, v] : [k, deepSortKeys(v)],
    ),
  );
  writeFileSync(
    path.join(vaultDir, CONFIG_NAME),
    JSON.stringify(out, null, 2) + "\n",
  );
}

const TAXONOMY_AXES = ["domain", "layer"];

/** Validate a proposed lint object before it is written to loom.json. Returns
 *  an error message, or null when the object is safe to save. Pure: no IO. */
export function validateLint(lint: unknown): string | null {
  if (typeof lint !== "object" || lint === null)
    return "lint must be an object";
  const l = lint as Record<string, unknown>;
  const strArr = (v: unknown): boolean =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  const intOk = (v: unknown): boolean =>
    v == null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
  if (l.requireTaxonomy != null) {
    if (!strArr(l.requireTaxonomy))
      return "requireTaxonomy must be a string array";
    for (const t of l.requireTaxonomy as string[])
      if (!TAXONOMY_AXES.includes(t))
        return `requireTaxonomy: unknown axis "${t}"`;
  }
  for (const k of ["allowedDomains", "allowedLayers", "requireSections"])
    if (l[k] != null && !strArr(l[k])) return `${k} must be a string array`;
  for (const k of [
    "descriptionMinChars",
    "descriptionMaxChars",
    "bodyMaxLines",
  ])
    if (!intOk(l[k])) return `${k} must be a non-negative integer`;
  if (
    typeof l.descriptionMinChars === "number" &&
    typeof l.descriptionMaxChars === "number" &&
    l.descriptionMinChars > l.descriptionMaxChars
  )
    return "descriptionMinChars must be <= descriptionMaxChars";
  if (l.forbidBodyPatterns != null) {
    if (!strArr(l.forbidBodyPatterns))
      return "forbidBodyPatterns must be a string array";
    for (const p of l.forbidBodyPatterns as string[]) {
      try {
        new RegExp(p);
      } catch {
        return `forbidBodyPatterns: invalid regex /${p}/`;
      }
    }
  }
  if (l.strict != null && typeof l.strict !== "boolean")
    return "strict must be a boolean";
  return null;
}
