import { loadConfig, type LintConfig } from "./config.js";
import {
  scanVault,
  validateVault,
  skillWarnings,
  isActive,
  type Skill,
  type SkillWarning,
} from "./vault.js";
import {
  agentStatusMatrix,
  orphanAgentLinks,
  orphanLinks,
  overrideFindings,
  statusMatrix,
} from "./linker.js";

// The vault's own rules, computed once, so both `doctor` (which prints) and
// `sync` (which gates a commit) share one definition of "healthy". Kept free of
// any dependency on sync.ts to avoid an import cycle.
export interface DoctorReport {
  /** Number of blocking problems. 0 means the vault passes its rules. */
  count: number;
  /** Blocking problem lines (validation, broken/foreign links, orphans, and —
   *  under lint.strict — enforceable hygiene findings). */
  blocking: string[];
  /** Non-blocking hygiene findings, shown by doctor but not gating. */
  warnings: string[];
}

/** Split lint/hygiene findings into those the gate enforces and those that are
 *  always advisory: prose-wall is editorial guidance, while findings on a known
 *  non-active skill do not block its lifecycle. Shared by collectDoctor and
 *  rulesImpact so the impact preview matches what a real save enforces. A finding
 *  whose name matches no scanned skill is NOT downgraded. */
function partitionFindings(
  skills: Skill[],
  findings: SkillWarning[],
): { enforced: SkillWarning[]; advisory: SkillWarning[] } {
  const allNames = new Set(skills.map((s) => s.name));
  const activeNames = new Set(skills.filter(isActive).map((s) => s.name));
  const isAdvisory = (w: SkillWarning) =>
    w.kind === "prose-wall" ||
    (allNames.has(w.name) && !activeNames.has(w.name));
  return {
    enforced: findings.filter((w) => !isAdvisory(w)),
    advisory: findings.filter(isAdvisory),
  };
}

export function collectDoctor(vaultDir: string): DoctorReport {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const problems = validateVault(skills);
  const unhealthy = statusMatrix(skills, cfg, vaultDir).filter(
    (m) => m.state === "broken" || m.state === "foreign",
  );
  const orphans = orphanLinks(vaultDir, cfg, skills);
  // The agent projection is held to the same bar as the skill one: a broken or
  // foreign link means the runtime is reading something other than the vault.
  const unhealthyAgents = agentStatusMatrix(skills, cfg).filter(
    (m) => m.state === "broken" || m.state === "foreign",
  );
  const agentOrphans = orphanAgentLinks(vaultDir, cfg, skills);
  const findings = skillWarnings(skills, cfg);
  const strict = cfg.lint?.strict === true;

  const blocking: string[] = [
    ...problems.map((p) => `vault ${p.kind}: ${p.detail}`),
    ...unhealthy.map(
      (u) => `consumer ${u.consumer}: "${u.skill}" is ${u.state}`,
    ),
    ...orphans.map((o) => `orphan link: ${o}`),
    ...unhealthyAgents.map(
      (u) => `consumer ${u.consumer}: agent link "${u.skill}" is ${u.state}`,
    ),
    ...agentOrphans.map((o) => `orphan agent link: ${o}`),
  ];
  // Strict lint enforcement (and blocking) only applies to active skills or to
  // config-level findings; a known non-active skill is advisory. This split is
  // shared with rulesImpact via partitionFindings, and rulesImpact evaluates
  // the same merged lint a save would write (see its own comment below), so
  // together the two keep the preview and the real enforcement in sync.
  const { enforced: blockPathFindings, advisory: advisoryFindings } =
    partitionFindings(skills, findings);
  const line = (w: (typeof findings)[number]): string =>
    w.file
      ? `${w.kind}: "${w.name}" (${w.file}) — ${w.detail}`
      : `${w.kind}: "${w.name}" — ${w.detail}`;
  // Hygiene findings block only under lint.strict, and only for
  // active-skill/config-level findings; otherwise they inform.
  if (strict) blocking.push(...blockPathFindings.map((w) => `lint ${line(w)}`));
  // An override that names nothing real never blocks: it points at a state the
  // vault does not have, which is a stale note, not a broken projection.
  const overrides = overrideFindings(cfg, skills).map(
    (o) => `warning override ${o.consumer}/"${o.skill}": ${o.detail}`,
  );
  const warnings = [
    ...overrides,
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
 *  would newly flag, and which currently-flagged skills it would let pass.
 *  `proposedLint` is merged over the vault's on-disk `cfg.lint` before being
 *  evaluated — the same merge POST /api/rules performs when it actually saves
 *  (`cfg.lint = { ...cfg.lint, ...lint }`) — so a posted lint that omits a
 *  field doesn't silently unset it here either. Combined with the shared
 *  active/advisory partitioning (see collectDoctor), the preview matches what
 *  a real save would enforce. Always-on findings (h1/absolute-path) sit in
 *  both sets and cancel in the delta. */
export function rulesImpact(
  vaultDir: string,
  proposedLint: LintConfig,
): RulesImpact {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const flagged = (lint: LintConfig | undefined): Map<string, string> => {
    const m = new Map<string, string>();
    // Only findings the gate would actually enforce belong in the preview — a
    // non-active skill is always advisory and never blocks (see collectDoctor).
    const { enforced } = partitionFindings(
      skills,
      skillWarnings(skills, { ...cfg, lint }),
    );
    for (const w of enforced) if (!m.has(w.name)) m.set(w.name, w.detail);
    return m;
  };
  const cur = flagged(cfg.lint);
  // Merge, not replace: POST /api/rules with apply:true merges the posted
  // lint over the on-disk one (server.ts `cfg.lint = { ...cfg.lint, ...lint }`)
  // rather than overwriting it wholesale. Merging here too, over the same
  // on-disk cfg.lint just loaded above, is what makes this preview match
  // that save instead of judging a different (posted-only) config.
  const prop = flagged({ ...cfg.lint, ...proposedLint });
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
