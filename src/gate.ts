import { loadConfig, type LintConfig } from "./config.js";
import { scanVault, validateVault, skillWarnings, isActive } from "./vault.js";
import { orphanLinks, statusMatrix } from "./linker.js";

// The vault's own rules, computed once, so both `doctor` (which prints) and
// `sync` (which gates a commit) share one definition of "healthy". Kept free of
// any dependency on sync.ts to avoid an import cycle.
export interface DoctorReport {
  /** Number of blocking problems. 0 means the vault passes its rules. */
  count: number;
  /** Blocking problem lines (validation, broken/foreign links, orphans, and —
   *  under lint.strict — hygiene findings). */
  blocking: string[];
  /** Non-blocking hygiene findings, shown by doctor but not gating (lenient). */
  warnings: string[];
}

export function collectDoctor(vaultDir: string): DoctorReport {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const problems = validateVault(skills);
  const unhealthy = statusMatrix(skills, cfg).filter(
    (m) => m.state === "broken" || m.state === "foreign",
  );
  const orphans = orphanLinks(vaultDir, cfg, skills);
  const findings = skillWarnings(skills, cfg);
  const strict = cfg.lint?.strict === true;

  const blocking: string[] = [
    ...problems.map((p) => `vault ${p.kind}: ${p.detail}`),
    ...unhealthy.map(
      (u) => `consumer ${u.consumer}: "${u.skill}" is ${u.state}`,
    ),
    ...orphans.map((o) => `orphan link: ${o}`),
  ];
  // Strict lint enforcement (and blocking) only applies to active skills, or
  // to findings with no skill at all (config-level, e.g. "(lint config)" for
  // an invalid forbidBodyPatterns regex). Only a finding that names a real,
  // known, non-active skill is advisory — a finding whose name matches no
  // scanned skill is NOT downgraded just because it fails to match "active".
  const allNames = new Set(skills.map((s) => s.name));
  const activeNames = new Set(skills.filter(isActive).map((s) => s.name));
  const advisoryFindings = findings.filter(
    (w) => allNames.has(w.name) && !activeNames.has(w.name),
  );
  const blockPathFindings = findings.filter(
    (w) => !(allNames.has(w.name) && !activeNames.has(w.name)),
  );
  const line = (w: (typeof findings)[number]): string =>
    `${w.kind}: "${w.name}" — ${w.detail}`;
  // Hygiene findings block only under lint.strict, and only for
  // active-skill/config-level findings; otherwise they inform.
  if (strict) blocking.push(...blockPathFindings.map((w) => `lint ${line(w)}`));
  const warnings = [
    ...advisoryFindings.map((w) => `warning ${line(w)}`),
    ...(strict ? [] : blockPathFindings.map((w) => `warning ${line(w)}`)),
  ];

  return { count: blocking.length, blocking, warnings };
}

export interface RulesImpact {
  currentFlagged: number;
  proposedFlagged: number;
  newlyFlagged: { name: string; reason: string }[];
  nowPass: string[];
}

/** Dry-run the effect of a proposed lint on the current vault: which skills it
 *  would newly flag, and which currently-flagged skills it would let pass. Uses
 *  the same skillWarnings the gate and doctor use, so the preview matches what a
 *  real save would enforce. Always-on findings (h1/absolute-path) sit in both
 *  sets and cancel in the delta. */
export function rulesImpact(
  vaultDir: string,
  proposedLint: LintConfig,
): RulesImpact {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const flagged = (lint: LintConfig | undefined): Map<string, string> => {
    const m = new Map<string, string>();
    for (const w of skillWarnings(skills, { ...cfg, lint }))
      if (!m.has(w.name)) m.set(w.name, w.detail);
    return m;
  };
  const cur = flagged(cfg.lint);
  const prop = flagged(proposedLint);
  const newlyFlagged: { name: string; reason: string }[] = [];
  for (const [name, reason] of prop)
    if (!cur.has(name)) newlyFlagged.push({ name, reason });
  const nowPass: string[] = [];
  for (const name of cur.keys()) if (!prop.has(name)) nowPass.push(name);
  newlyFlagged.sort((a, b) => a.name.localeCompare(b.name));
  nowPass.sort();
  return {
    currentFlagged: cur.size,
    proposedFlagged: prop.size,
    newlyFlagged,
    nowPass,
  };
}
