import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { UsageError } from "./errors.js";

/** A document whose shape is fixed by convention: it must open with a given H1
 *  and, if asked, carry a table. Which documents these are is the vault's to
 *  say — the engine only knows how to check a shape. */
export interface StructuredDoc {
  /** Path relative to the skill's folder, e.g. "live-state.md". */
  file: string;
  h1Prefix?: string;
  requireTable?: boolean;
}

/** Optional content gate. Every field is opt-in: an absent block leaves doctor
 *  with only its built-in hygiene warnings. `strict` turns enforceable findings
 *  into exit-code failures; editorial signals such as prose-wall stay advisory. */
export interface LintConfig {
  strict?: boolean;
  descriptionMinChars?: number;
  descriptionMaxChars?: number;
  bodyMaxLines?: number;
  proseMaxWords?: number;
  requireSections?: string[];
  requireTaxonomy?: string[];
  allowedDomains?: string[];
  allowedLayers?: string[];
  forbidBodyPatterns?: string[];
  absolutePathIgnoreFiles?: string[];
  structuredDocs?: StructuredDoc[];
  protectedTerms?: string[];
  lossAcceptances?: LossAcceptance[];
}

/** A reviewed, deliberate exception to content-preservation: a specific term is
 *  allowed to be missing from a specific file, because a human looked at the
 *  loss and accepted it. `baseline` pins the acceptance to the exact old text
 *  it was reviewed against — if that text changes, the acceptance goes stale
 *  and the loss must be re-reviewed. */
export interface LossAcceptance {
  /** The legacy (baseline) path the loss was accepted against — the same
   *  path the audit iterates (via `git ls-tree base`) and hashes (via
   *  `git show base:file`). For an in-place rewrite this equals the
   *  working-tree path; for a rename or split it is the OLD path. */
  file: string;
  /** The single protected term whose loss is accepted. */
  term: string;
  /** Non-empty human reason. Auto-generation is forbidden. */
  reason: string;
  /** sha256 hex of the baseline (old) text this loss was reviewed against.
   *  If the baseline text changes, the acceptance goes stale and the loss
   *  fails again. */
  baseline: string;
  /** Files where the term was CHECKED to survive when the acceptance was made.
   *  `reason` is prose and can claim a destination that does not hold it; this
   *  is the part the tool verified. Empty only on records written before the
   *  check existed. */
  verifiedIn?: string[];
  /** The content is gone on purpose and has no destination to point at — the
   *  author said so explicitly rather than letting a vague reason imply a
   *  survival that was never checked. Mutually exclusive with `verifiedIn`. */
  dropped?: boolean;
}

export type ConsumerMode = "symlink" | "in-place";

/** Who owns one (consumer, skill) pair.
 *
 *  `managed` — skill-loom projects the vault into that runtime. The default,
 *  and what every pair was before this existed.
 *  `external` — a skill by that name in that runtime is the runtime's own, and
 *  none of the vault's business: never linked, never planned, never a finding.
 *  A deliberate conflict, declared, so `doctor` stops calling it an error.
 *  `disabled` — the vault has the skill but that runtime must not see it. Also
 *  never linked, but the vault still says the name is its own, so a link left
 *  behind is drift worth reporting rather than someone else's folder. */
export type ProjectionState = "managed" | "external" | "disabled";

/** consumer -> skill -> state. Absent entries are `managed`. */
export type ProjectionOverrides = Record<
  string,
  Record<string, ProjectionState>
>;

export const PROJECTION_STATES: ProjectionState[] = [
  "managed",
  "external",
  "disabled",
];

/** The file the overrides live in, beside `loom.json` and NOT in git.
 *
 *  An override describes this machine — which runtime happens to have its own
 *  copy of a name here — not the nature of the skill, which is what `loom.json`
 *  is for. The same vault cloned to another machine gets its own answer. */
export const LOCAL_CONFIG_NAME = "loom.local.json";

export function projectionOf(
  cfg: LoomConfig,
  consumer: string,
  skillName: string,
): ProjectionState {
  return cfg.projectionOverrides?.[consumer]?.[skillName] ?? "managed";
}

/** True when skill-loom owns this pair and should link it. */
export function isManaged(
  cfg: LoomConfig,
  consumer: string,
  skillName: string,
): boolean {
  return projectionOf(cfg, consumer, skillName) === "managed";
}

/** Reads `loom.local.json`, or `{}` when there is none.
 *
 *  Same posture as the `lint` block: a malformed overlay is a hard error, never
 *  a silent `{}`. An override that quietly fails to load re-links over someone
 *  else's folder and re-breaks the gate — exactly the state it was written to
 *  prevent — and it would look like skill-loom ignoring the file. */
export function loadProjectionOverrides(vaultDir: string): ProjectionOverrides {
  const file = path.join(vaultDir, LOCAL_CONFIG_NAME);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new UsageError(
      `invalid ${LOCAL_CONFIG_NAME} in ${vaultDir}: ${message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new UsageError(
      `invalid ${LOCAL_CONFIG_NAME} in ${vaultDir}: expected a JSON object`,
    );
  const raw = (parsed as { projectionOverrides?: unknown }).projectionOverrides;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new UsageError(
      `${LOCAL_CONFIG_NAME}: projectionOverrides must be an object of consumer -> skill -> state`,
    );
  const out: ProjectionOverrides = {};
  for (const [consumer, skills] of Object.entries(raw)) {
    if (typeof skills !== "object" || skills === null || Array.isArray(skills))
      throw new UsageError(
        `${LOCAL_CONFIG_NAME}: projectionOverrides["${consumer}"] must be an object of skill -> state`,
      );
    const entries: Record<string, ProjectionState> = {};
    for (const [skill, state] of Object.entries(skills)) {
      if (
        typeof state !== "string" ||
        !PROJECTION_STATES.includes(state as ProjectionState)
      )
        throw new UsageError(
          `${LOCAL_CONFIG_NAME}: projectionOverrides["${consumer}"]["${skill}"] must be one of ${PROJECTION_STATES.join(", ")}`,
        );
      entries[skill] = state as ProjectionState;
    }
    out[consumer] = entries;
  }
  return out;
}

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
      /** Where this runtime discovers *agent* definitions, if it has a second
       *  root for them (Claude Code: `~/.claude/agents`). Declaring it opts the
       *  consumer into agent projection; leaving it out is how every runtime
       *  that has no such root stays untouched. */
      agentsDir?: string;
    };

export interface LoomConfig {
  schema: 1;
  consumers: Record<string, ConsumerValue>;
  ignore: string[];
  /** Custom word casing for humanized names/labels: kebab word → cased form
   *  (e.g. { "acmeai": "AcmeAI" }). Merged over the built-in dictionaries. */
  names: Record<string, string>;
  lint?: LintConfig;
  /** Loaded from `loom.local.json`, never from `loom.json`, and stripped again
   *  by `saveConfig` — it rides on the config object only so the projection
   *  code that already receives one does not need a second parameter threaded
   *  through fifty call sites. See `LOCAL_CONFIG_NAME`. */
  projectionOverrides?: ProjectionOverrides;
  /** The vault's declared taxonomy axes, keyed by axis id, in the order they
   *  should appear in the UI. Absent means the vault hasn't declared one —
   *  see `resolveAxes` for the fallback chain. */
  taxonomy?: Record<
    string,
    {
      label?: string;
      values?: string[];
      /** Pinned hue per value, `[hue]` or `[hue, chroma]`. Rank-derived hues
       *  recolour the whole library whenever a value is added; a pinned hue is
       *  a promise that a value keeps its colour for life. */
      hues?: Record<string, number[]>;
      /** Whether skill tiles inherit this axis's hue when the skill declares
       *  no icon-color of its own. At most one axis should carry it. */
      tile?: boolean;
    }
  >;
}

/** A consumer resolved to a uniform shape.
 *
 *  `dir` is the link target: the directory skill-loom symlinks the vault into.
 *  It is `null` for in-place consumers, which are served by reading the vault
 *  through their own config, so linking into them would be wrong.
 *
 *  `skillsDir` is the runtime's own skills root, used for reading rather than
 *  writing (browsing the skills it ships itself). For a symlink consumer it is
 *  the same directory as `dir`. An in-place consumer can still have one — being
 *  served in place says nothing about whether the runtime also keeps a skills
 *  folder of its own — so it is set from `path` whatever the mode, and stays
 *  `null` only when no path is declared. */
export interface Consumer {
  name: string;
  mode: ConsumerMode;
  dir: string | null;
  skillsDir: string | null;
  /** The runtime's agent-definition root, or `null` when it has none. A skill's
   *  `agents/` folder is projected here as one directory link per skill — the
   *  runtime walks it recursively and reads each agent's identity from its own
   *  frontmatter, so the folder a definition sits in carries no meaning. */
  agentsDir: string | null;
  note?: string;
  servedVia?: ServedVia;
}

export function resolveConsumers(cfg: LoomConfig): Consumer[] {
  return Object.entries(cfg.consumers).map(([name, value]) => {
    if (typeof value === "string") {
      const dir = expandTilde(value);
      return { name, mode: "symlink", dir, skillsDir: dir, agentsDir: null };
    }
    const mode: ConsumerMode = value.mode ?? "symlink";
    const declared = value.path ? expandTilde(value.path) : null;
    // A blank agentsDir is dropped rather than expanded: an empty path would
    // resolve against the process CWD and drop stray links there.
    const agentsDir =
      typeof value.agentsDir === "string" && value.agentsDir.trim()
        ? expandTilde(value.agentsDir)
        : null;
    return {
      name,
      mode,
      dir: mode === "symlink" ? declared : null,
      skillsDir: declared,
      agentsDir,
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

  // Same posture as `names`: a `taxonomy` block that isn't even an object is
  // a warning, not a hard error — resolveAxes falls back to the legacy/
  // default pair either way, so there is no unsafe state to guard against by
  // throwing here. A well-formed-but-invalid per-axis entry (bad id shape, a
  // reserved id, a malformed `values`) is a different failure class — that
  // one degrades silently downstream instead of falling back, so it's a hard
  // error, thrown by resolveAxes itself once the axes are actually resolved.
  let taxonomy: LoomConfig["taxonomy"];
  if (raw.taxonomy !== undefined) {
    if (
      typeof raw.taxonomy === "object" &&
      raw.taxonomy !== null &&
      !Array.isArray(raw.taxonomy)
    ) {
      taxonomy = raw.taxonomy;
    } else {
      warn("taxonomy must be an object — ignoring it");
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

  const projectionOverrides = loadProjectionOverrides(vaultDir);

  return {
    schema: 1,
    consumers,
    ignore,
    names,
    ...(raw.lint ? { lint: raw.lint } : {}),
    ...(Object.keys(projectionOverrides).length ? { projectionOverrides } : {}),
    ...(taxonomy ? { taxonomy } : {}),
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
      ...(cfg.lint.protectedTerms
        ? { protectedTerms: sortArr(cfg.lint.protectedTerms) }
        : {}),
      ...(cfg.lint.lossAcceptances
        ? {
            lossAcceptances: [...cfg.lint.lossAcceptances].sort((a, b) =>
              a.file === b.file
                ? a.term.localeCompare(b.term)
                : a.file.localeCompare(b.file),
            ),
          }
        : {}),
    };
    const known = LINT_KEY_ORDER.filter((k) => k in sorted);
    const extra = Object.keys(sorted)
      .filter((k) => !LINT_KEY_ORDER.includes(k))
      .sort();
    lint = Object.fromEntries([...known, ...extra].map((k) => [k, sorted[k]]));
  }
  // The overlay comes from loom.local.json and goes back to it, never here:
  // loadConfig hands back one object carrying both, and without this line the
  // first save from the dashboard would write this machine's overrides into
  // the tracked file — a leak that would look like it worked.
  const { projectionOverrides: _local, ...rest } = cfg;
  const staged = { ...rest, ...(lint ? { lint } : {}) };
  const out = Object.fromEntries(
    Object.entries(staged).map(([k, v]) =>
      // lint keeps its semantic key order; deepSortKeys would re-alphabetize it.
      // taxonomy's key order is semantic too — it drives column/filter order
      // in the UI — so it gets the same exclusion.
      k === "lint" || k === "taxonomy" ? [k, v] : [k, deepSortKeys(v)],
    ),
  );
  writeFileSync(
    path.join(vaultDir, CONFIG_NAME),
    JSON.stringify(out, null, 2) + "\n",
  );
}

/** One taxonomy axis as the vault declares it. `values` absent means the axis
 *  exists but is not validated — never "no value is allowed". */
export interface TaxonomyAxis {
  id: string;
  label?: string;
  values?: string[];
  /** value -> [hue] | [hue, chroma], validated; absent entries fall back to
   *  the rank-derived palette. */
  hues?: Record<string, [number, number?]>;
  tile?: boolean;
}

/** What a vault gets when it declares nothing: the pair skill-loom shipped
 *  with, unvalidated, so a config-less vault keeps its columns and filters. */
export const DEFAULT_AXIS_IDS = ["domain", "layer"] as const;

// An axis id becomes a CSS id fragment (src/ui.js's `n-ax-<id>`), a CSS
// attribute selector (`data-<id>`), and an unescaped RegExp source
// (src/ops.ts's setFrontmatterField). This shape is simultaneously safe for
// all three: lowercase, digits and hyphens, starting with a letter.
const AXIS_ID_RE = /^[a-z][a-z0-9-]*$/;

// Ids an axis must not use because they already name a field on the skill
// object every consumer spreads axisFields() onto: name/title/description/
// icon/iconColor/status/date from scanArchived's literal (src/server.ts),
// health/dir/rel/sync/modified from buildState's skill mapper (also
// src/server.ts) — a declared axis with one of these ids would silently
// clobber (or be clobbered by) the real field. `link` isn't a spread field
// but is one of the rail's fixed "kind"s (src/ui.js) checked only *after*
// `axisList().some(a => a.id === kind)` — an axis named `link` (or `status`/
// `sync`, already covered above) would shadow that filter. `skill` and `hay`
// aren't spread either: libCard/the ledger row (src/ui.js) write
// `data-skill=`/`data-hay=` *before* `${axisDataAttrs(s)}` in the same
// template string — HTML keeps only the first of a duplicate attribute, so
// an axis named `skill` or `hay` would have its own data- attribute silently
// dropped by the parser and never match filterLibrary's lookup.
const RESERVED_AXIS_IDS = new Set([
  "name",
  "title",
  "description",
  "icon",
  "iconColor",
  "status",
  "date",
  "health",
  "dir",
  "rel",
  "sync",
  "modified",
  "link",
  "skill",
  "hay",
]);

/** The single source of truth on which axes exist. Precedence:
 *  1. `taxonomy` as declared (legacy keys ignored, never merged — one source
 *     of truth at a time);
 *  2. synthesised from `lint.allowedDomains` / `lint.allowedLayers`;
 *  3. the default pair.
 *  Never returns an empty list.
 *
 *  A declared axis id must be lowercase-kebab (`AXIS_ID_RE`) and not one of
 *  `RESERVED_AXIS_IDS`, and a declared `values` must be an array of strings
 *  when present — the CLI/gate default pair and any legacy-synthesised axes
 *  are exempt (they never flow through user-typed JSON keys). Violations
 *  throw `UsageError`: a malformed or reserved axis id degrades silently
 *  everywhere downstream (dropped form values, corrupted DOM ids, substring-
 *  matched `values`), so — like the lint-block guard above — this is a hard
 *  error rather than a warning. */
export function resolveAxes(cfg: LoomConfig): TaxonomyAxis[] {
  const clean = (v?: string[]): string[] | undefined =>
    v && v.length ? v : undefined;
  const declared = cfg.taxonomy;
  if (declared && Object.keys(declared).length)
    return Object.entries(declared).map(([id, a]) => {
      if (!AXIS_ID_RE.test(id))
        throw new UsageError(
          `${CONFIG_NAME}: taxonomy axis "${id}" is not a valid id — must match ${AXIS_ID_RE} (lowercase letters, digits and hyphens, starting with a letter)`,
        );
      if (RESERVED_AXIS_IDS.has(id))
        throw new UsageError(
          `${CONFIG_NAME}: taxonomy axis "${id}" is a reserved name and would clobber a built-in skill field`,
        );
      const rawValues = a?.values;
      if (
        rawValues !== undefined &&
        (!Array.isArray(rawValues) ||
          rawValues.some((v) => typeof v !== "string"))
      )
        throw new UsageError(
          `${CONFIG_NAME}: taxonomy axis "${id}".values must be an array of strings`,
        );
      // A malformed hue entry is dropped with a throw rather than a silent
      // skip: a typo'd pin would otherwise fall back to the rank palette and
      // recolour that one value without anyone noticing.
      let hues: Record<string, [number, number?]> | undefined;
      if (a?.hues !== undefined) {
        if (
          typeof a.hues !== "object" ||
          a.hues === null ||
          Array.isArray(a.hues)
        )
          throw new UsageError(
            `${CONFIG_NAME}: taxonomy axis "${id}".hues must be an object of value -> [hue] or [hue, chroma]`,
          );
        hues = {};
        for (const [value, spec] of Object.entries(a.hues)) {
          if (
            !Array.isArray(spec) ||
            spec.length < 1 ||
            spec.length > 2 ||
            spec.some((n) => typeof n !== "number" || !Number.isFinite(n))
          )
            throw new UsageError(
              `${CONFIG_NAME}: taxonomy axis "${id}".hues["${value}"] must be [hue] or [hue, chroma]`,
            );
          hues[value] = spec as [number, number?];
        }
      }
      return {
        id,
        ...(a?.label ? { label: a.label } : {}),
        ...(clean(rawValues) ? { values: clean(rawValues) } : {}),
        ...(hues && Object.keys(hues).length ? { hues } : {}),
        ...(a?.tile === true ? { tile: true } : {}),
      };
    });
  const lint = cfg.lint;
  if (lint?.allowedDomains?.length || lint?.allowedLayers?.length)
    return [
      {
        id: "domain",
        ...(clean(lint.allowedDomains)
          ? { values: clean(lint.allowedDomains) }
          : {}),
      },
      {
        id: "layer",
        ...(clean(lint.allowedLayers)
          ? { values: clean(lint.allowedLayers) }
          : {}),
      },
    ];
  return DEFAULT_AXIS_IDS.map((id) => ({ id }));
}

/** Validate a proposed lint object before it is written to loom.json. Returns
 *  an error message, or null when the object is safe to save. Pure: no IO.
 *  `axes` is the vault's resolved taxonomy (see `resolveAxes`) — the set of
 *  ids `requireTaxonomy` is allowed to reference. */
export function validateLint(
  lint: unknown,
  axes: TaxonomyAxis[],
): string | null {
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
    const ids = axes.map((a) => a.id);
    for (const t of l.requireTaxonomy as string[])
      if (!ids.includes(t)) return `requireTaxonomy: unknown axis "${t}"`;
  }
  for (const k of ["allowedDomains", "allowedLayers", "requireSections"])
    if (l[k] != null && !strArr(l[k])) return `${k} must be a string array`;
  for (const k of [
    "descriptionMinChars",
    "descriptionMaxChars",
    "bodyMaxLines",
    "proseMaxWords",
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
  if (l.absolutePathIgnoreFiles != null) {
    if (
      !Array.isArray(l.absolutePathIgnoreFiles) ||
      l.absolutePathIgnoreFiles.some((f) => typeof f !== "string" || !f)
    )
      return "absolutePathIgnoreFiles must be an array of non-empty strings";
  }
  if (l.structuredDocs != null) {
    if (!Array.isArray(l.structuredDocs))
      return "structuredDocs must be an array";
    for (const d of l.structuredDocs) {
      if (!d || typeof d !== "object" || typeof d.file !== "string" || !d.file)
        return "structuredDocs: every entry needs a non-empty file";
      if (d.h1Prefix != null && typeof d.h1Prefix !== "string")
        return `structuredDocs: h1Prefix for "${d.file}" must be a string`;
      if (d.requireTable != null && typeof d.requireTable !== "boolean")
        return `structuredDocs: requireTable for "${d.file}" must be a boolean`;
    }
  }
  if (l.protectedTerms != null && !strArr(l.protectedTerms))
    return "lint.protectedTerms must be an array of strings";
  if (l.lossAcceptances != null) {
    if (!Array.isArray(l.lossAcceptances))
      return "lint.lossAcceptances must be an array";
    for (const a of l.lossAcceptances) {
      if (typeof a !== "object" || a === null)
        return "lint.lossAcceptances entries must be objects";
      const e = a as Record<string, unknown>;
      for (const k of ["file", "term", "reason", "baseline"]) {
        if (typeof e[k] !== "string" || (e[k] as string).length === 0)
          return `lint.lossAcceptances: "${k}" must be a non-empty string`;
      }
      if ((e.reason as string).trim().length === 0)
        return "lint.lossAcceptances: reason must not be blank";
      if (e.verifiedIn != null && !strArr(e.verifiedIn))
        return "lint.lossAcceptances: verifiedIn must be an array of strings";
      if (e.dropped != null && typeof e.dropped !== "boolean")
        return "lint.lossAcceptances: dropped must be a boolean";
      if (
        e.dropped === true &&
        strArr(e.verifiedIn) &&
        (e.verifiedIn as string[]).length > 0
      )
        return "lint.lossAcceptances: an entry is either verifiedIn or dropped, not both";
    }
  }
  return null;
}
