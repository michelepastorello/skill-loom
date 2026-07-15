import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveConsumers, loadConfig, type LintConfig } from "./config.js";
import {
  ARCHIVE_DIR,
  NAME_RE,
  isActive,
  parseFrontmatterField,
  scanVault,
  type Skill,
} from "./vault.js";
import { applyPlan, planLinks, setSkillLinks, resolveLink } from "./linker.js";

export interface OpOutcome {
  status: 0 | 1 | 2;
  message: string;
  actions: string[];
  /** Present when a rule gate blocked the op: the blocking problems. Lets the
   *  UI offer a "commit anyway" (force) path instead of a dead-end error. */
  gate?: string[];
}

const DEFAULT_DESCRIPTION = "Describe when this skill should be used";

export interface AddOptions {
  description?: string;
  domain?: string;
  layer?: string;
  status?: string;
}

export function addOp(
  vaultDir: string,
  name: string | undefined,
  opts: AddOptions,
  apply: boolean,
): OpOutcome {
  if (!name) {
    return {
      status: 2,
      message: "usage: skill-loom add <name>",
      actions: [],
    };
  }
  if (!NAME_RE.test(name)) {
    return {
      status: 2,
      message: `invalid skill name "${name}" — must match ${NAME_RE}`,
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  if (scanVault(vaultDir, cfg).some((s) => s.name === name)) {
    return {
      status: 2,
      message: `skill "${name}" already exists in vault`,
      actions: [],
    };
  }
  // Enforce the vault's required taxonomy at creation, so a new skill is born
  // compliant instead of failing the gate on its first sync.
  const lint = cfg.lint;
  const taxo = { domain: opts.domain, layer: opts.layer, status: opts.status };
  const missing = (lint?.requireTaxonomy ?? []).filter(
    (k) => !taxo[k as keyof typeof taxo],
  );
  if (missing.length) {
    return {
      status: 2,
      message: `this vault's rules require ${missing.join(", ")} on every skill`,
      actions: [],
    };
  }
  // The vault is flat: a skill is a folder at the vault root named for the skill.
  const dir = path.join(vaultDir, name);
  const mdPath = path.join(dir, "SKILL.md");
  if (!apply) {
    return {
      status: 0,
      message: `would create ${mdPath}`,
      actions: [`create ${mdPath}`],
    };
  }
  const desc = (opts.description ?? DEFAULT_DESCRIPTION).replace(
    /[\r\n]+/g,
    " ",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(mdPath, buildSkillMd(name, desc, taxo, lint));
  return {
    status: 0,
    message: `created ${mdPath}`,
    actions: [`create ${mdPath}`],
  };
}

// The SKILL.md a fresh skill starts with. When the vault declares taxonomy or
// required sections (loom.json lint), scaffold them uncommented so the skill is
// born gate-ready; a vault with no such rules keeps the commented hint.
function buildSkillMd(
  name: string,
  desc: string,
  taxo: { domain?: string; layer?: string; status?: string },
  lint?: LintConfig,
): string {
  const provided = taxo.domain || taxo.layer || taxo.status;
  const taxoConfigured =
    (lint?.requireTaxonomy?.length ?? 0) > 0 ||
    (lint?.allowedDomains?.length ?? 0) > 0 ||
    (lint?.allowedLayers?.length ?? 0) > 0;
  let front: string;
  if (provided || taxoConfigured) {
    const lines = [`name: ${name}`, `description: ${desc}`];
    if (taxo.domain) lines.push(`domain: ${taxo.domain}`);
    if (taxo.layer) lines.push(`layer: ${taxo.layer}`);
    lines.push(`status: ${taxo.status || "draft"}`);
    front = `---\n${lines.join("\n")}\n---\n`;
  } else {
    front = `---\nname: ${name}\ndescription: ${desc}\n# Optional taxonomy: powers grouping, filters and colors in the dashboard.\n# Uncomment and use your own vocabulary:\n# domain: my-brand\n# layer: tool\n# status: draft\n# icon: sparkles\n# icon-color: teal-500\n---\n`;
  }
  let body = `\n# ${name}\n`;
  for (const section of lint?.requireSections ?? []) {
    body += `\n## ${section}\n\n<!-- describe the ${section.toLowerCase()} for this skill -->\n`;
  }
  return front + body;
}

// Rewrites a single frontmatter field on an existing skill's SKILL.md — used
// by the lifecycle-state UI (and, in Phase 2, by bulk endpoints that loop
// this per selected skill). Replaces the field's line if present, else
// inserts it at the end of the frontmatter block; dry-run when `apply` is
// false, following the same pattern as migrateOp/archiveOp.
// Set (or append) a frontmatter field, operating ONLY inside the `---...---`
// block so a body line that happens to start with `field:` is never rewritten.
// Returns the new file content, or null if there is no frontmatter block.
function setFrontmatterField(
  src: string,
  field: string,
  value: string,
): string | null {
  const m = /^(---\n)([\s\S]*?)(\n---\n)/.exec(src);
  if (!m) return null;
  const re = new RegExp(`^${field}:.*$`, "m");
  const block = re.test(m[2])
    ? m[2].replace(re, () => `${field}: ${value}`)
    : `${m[2]}\n${field}: ${value}`;
  return (
    src.slice(0, m.index) +
    m[1] +
    block +
    m[3] +
    src.slice(m.index + m[0].length)
  );
}

export function setFieldOp(
  vaultDir: string,
  name: string,
  field: "status" | "domain" | "layer",
  value: string,
  apply: boolean,
): OpOutcome {
  const md = path.join(vaultDir, name, "SKILL.md");
  if (!existsSync(md))
    return { status: 2, message: `${name} not found`, actions: [] };
  if (/[\r\n]/.test(value))
    return {
      status: 2,
      message: `${field} value must be a single line`,
      actions: [],
    };
  const out = setFrontmatterField(readFileSync(md, "utf8"), field, value);
  if (out === null)
    return { status: 2, message: `${name}: no frontmatter`, actions: [] };
  const actions = [`set ${field}=${value} on "${name}"`];
  if (!apply)
    return { status: 0, message: "dry-run — nothing changed", actions };
  writeFileSync(md, out);
  return { status: 0, message: `updated ${name}`, actions };
}

const BULK_STATUSES = new Set([
  "idea",
  "draft",
  "active",
  "suspended",
  "deprecated",
]);

// Validate-then-apply a per-name op across a batch, guaranteeing the whole-set-
// before-mutate invariant: pass 1 dry-runs every member and, if any is invalid,
// aborts with status 2 and the full offender list, writing nothing; pass 2
// applies only when `apply` is true. Returns the aggregated actions.
export function bulkApply(
  names: string[],
  op: (name: string, apply: boolean) => OpOutcome,
  apply: boolean,
  okMessage: string,
): OpOutcome {
  const dry = names.map((n) => ({ n, out: op(n, false) }));
  const bad = dry.filter((x) => x.out.status !== 0);
  if (bad.length)
    return {
      status: 2,
      message: bad.map((x) => `${x.n}: ${x.out.message}`).join("; "),
      actions: [],
    };
  const actions = dry.flatMap((x) => x.out.actions);
  if (apply) {
    // Whole-set validation (pass 1) guarantees each item was valid; a failure
    // here is a runtime error (fs, permissions, a race since the dry-run). Keep
    // applying the rest and report which items failed instead of throwing or
    // claiming blind success — the items are independent.
    const failed: string[] = [];
    for (const n of names) {
      try {
        const out = op(n, true);
        if (out.status !== 0) failed.push(`${n}: ${out.message}`);
      } catch (err) {
        failed.push(
          `${n}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (failed.length) {
      return {
        status: 1,
        message: `applied ${names.length - failed.length}/${names.length}; failed: ${failed.join("; ")}`,
        actions,
      };
    }
  }
  return {
    status: 0,
    message: apply ? okMessage : "dry-run — nothing changed",
    actions,
  };
}

// Bulk status change. Rewrites `status` on every named skill and, for the
// skills that cross the `active` boundary, links (promote) or unlinks (demote)
// across every configured consumer via setSkillLinks (which self-skips in-place
// consumers). Validates the whole set first: an unknown name aborts before any
// write. The direction is computed from the ORIGINAL scan, so it is correct
// whether the frontmatter has been rewritten yet or not.
export function bulkStatusOp(
  vaultDir: string,
  names: string[],
  status: string,
  apply: boolean,
): OpOutcome {
  if (!BULK_STATUSES.has(status))
    return { status: 2, message: `invalid status "${status}"`, actions: [] };
  const cfg = loadConfig(vaultDir);
  const byName = new Map(scanVault(vaultDir, cfg).map((s) => [s.name, s]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length)
    return {
      status: 2,
      message: `not in vault: ${missing.join(", ")}`,
      actions: [],
    };
  const targets = names.map((n) => byName.get(n) as Skill);
  const wantActive = status === "active";
  const promote = targets.filter((s) => !isActive(s) && wantActive);
  const demote = targets.filter((s) => isActive(s) && !wantActive);
  // Rewrite every status field, validating the whole set before any write.
  const base = bulkApply(
    names,
    (n, a) => setFieldOp(vaultDir, n, "status", status, a),
    apply,
    `set status=${status} on ${names.length} skill(s)`,
  );
  if (base.status !== 0) return base;
  const actions = [...base.actions];
  const linkChange = (subset: Skill[], on: boolean) => {
    if (!subset.length) return;
    for (const { name: consumer } of resolveConsumers(cfg)) {
      const { actions: a } = setSkillLinks(
        subset,
        cfg,
        consumer,
        null,
        on,
        apply,
      );
      actions.push(...a);
    }
  };
  linkChange(promote, true);
  linkChange(demote, false);
  return { ...base, actions };
}

// Bulk domain/layer. Validates the value against the vault's allowlist ONLY
// when one is declared (mirrors addOp's permissiveness for vaults with no
// taxonomy rules), then rewrites the field via the shared bulkApply helper
// (Task 1), which validates every skill's rewrite is possible before writing.
export function bulkTaxonomyOp(
  vaultDir: string,
  names: string[],
  field: "domain" | "layer",
  value: string,
  apply: boolean,
): OpOutcome {
  if (field !== "domain" && field !== "layer")
    return { status: 2, message: "field must be domain or layer", actions: [] };
  if (!value)
    return { status: 2, message: `${field} value is required`, actions: [] };
  if (/[\r\n]/.test(value))
    return {
      status: 2,
      message: `${field} value must be a single line`,
      actions: [],
    };
  const cfg = loadConfig(vaultDir);
  const allowed =
    field === "domain" ? cfg.lint?.allowedDomains : cfg.lint?.allowedLayers;
  if (allowed && allowed.length && !allowed.includes(value))
    return {
      status: 2,
      message: `"${value}" is not an allowed ${field} (${allowed.join(", ")})`,
      actions: [],
    };
  const present = new Set(scanVault(vaultDir, cfg).map((s) => s.name));
  const missing = names.filter((n) => !present.has(n));
  if (missing.length)
    return {
      status: 2,
      message: `not in vault: ${missing.join(", ")}`,
      actions: [],
    };
  return bulkApply(
    names,
    (n, a) => setFieldOp(vaultDir, n, field, value, a),
    apply,
    `set ${field}=${value} on ${names.length} skill(s)`,
  );
}

// Bulk archive: validates every name is a live vault skill (clear aggregated
// message), then routes through the shared bulkApply helper (Task 1) so
// archiveOp's own dry-run checks (dest collision) also run for the whole set
// before any move.
export function bulkArchiveOp(
  vaultDir: string,
  names: string[],
  apply: boolean,
): OpOutcome {
  const cfg = loadConfig(vaultDir);
  const present = new Set(scanVault(vaultDir, cfg).map((s) => s.name));
  const missing = names.filter((n) => !present.has(n));
  if (missing.length)
    return {
      status: 2,
      message: `not in vault: ${missing.join(", ")}`,
      actions: [],
    };
  return bulkApply(
    names,
    (n, a) => archiveOp(vaultDir, n, a),
    apply,
    `archived ${names.length} skill(s)`,
  );
}

// Bulk restore: validates every name is present in .archive/ (clear aggregated
// message), then routes through bulkApply.
export function bulkRestoreOp(
  vaultDir: string,
  names: string[],
  apply: boolean,
): OpOutcome {
  const invalid = names.filter((n) => !NAME_RE.test(n));
  if (invalid.length)
    return {
      status: 2,
      message: `invalid name(s): ${invalid.join(", ")} — must match ${NAME_RE}`,
      actions: [],
    };
  const missing = names.filter(
    (n) => !existsSync(path.join(vaultDir, ARCHIVE_DIR, n, "SKILL.md")),
  );
  if (missing.length)
    return {
      status: 2,
      message: `not archived: ${missing.join(", ")}`,
      actions: [],
    };
  return bulkApply(
    names,
    (n, a) => restoreOp(vaultDir, n, a),
    apply,
    `restored ${names.length} skill(s)`,
  );
}

export interface RenameTransform {
  op: "add-prefix" | "strip-prefix" | "replace";
  value?: string; // add-prefix / strip-prefix
  from?: string; // replace
  to?: string; // replace
}

// Bulk rename as a pattern transform (not N free-text renames). Pre-computes
// every old -> new, validates the WHOLE batch (name syntax + collision against
// any current vault name and against another new name in the batch), and only
// then loops migrateOp. A member whose name does not change is skipped.
export function bulkRenameOp(
  vaultDir: string,
  names: string[],
  transform: RenameTransform,
  apply: boolean,
): OpOutcome {
  const cfg = loadConfig(vaultDir);
  const present = new Set(scanVault(vaultDir, cfg).map((s) => s.name));
  const missing = names.filter((n) => !present.has(n));
  if (missing.length)
    return {
      status: 2,
      message: `not in vault: ${missing.join(", ")}`,
      actions: [],
    };
  const rename = (name: string): string => {
    if (transform.op === "add-prefix") return `${transform.value ?? ""}${name}`;
    if (transform.op === "strip-prefix") {
      const p = transform.value ?? "";
      return p && name.startsWith(p) ? name.slice(p.length) : name;
    }
    const from = transform.from ?? "";
    return from && name.includes(from)
      ? name.replace(from, transform.to ?? "")
      : name;
  };
  const pairs = names.map((name) => ({ old: name, next: rename(name) }));
  // `seen` starts with every current vault name, so a new name colliding with a
  // skill that is ALSO being renamed is still refused (conservative: avoids
  // order-dependent partial application inside migrateOp's sequential loop).
  const seen = new Set<string>(present);
  const errs: string[] = [];
  for (const { old, next } of pairs) {
    if (next === old) continue;
    if (!NAME_RE.test(next)) errs.push(`"${old}" -> "${next}" (invalid name)`);
    else if (seen.has(next)) errs.push(`"${old}" -> "${next}" (name taken)`);
    seen.add(next);
  }
  if (errs.length)
    return {
      status: 2,
      message: `rename conflicts: ${errs.join("; ")}`,
      actions: [],
    };
  const changed = pairs.filter((p) => p.next !== p.old);
  if (!changed.length)
    return { status: 0, message: "no names changed", actions: [] };
  // Validate every rename as a dry-run before mutating anything, so a member
  // migrateOp would refuse (e.g. a stray target dir) aborts the whole batch
  // with the full offender list and zero writes. bulkApply cannot be reused
  // here because migrateOp is keyed on (old, new), not a single name.
  const preErrs = changed
    .map(({ old, next }) => ({
      old,
      next,
      out: migrateOp(vaultDir, old, next, false),
    }))
    .filter((x) => x.out.status !== 0);
  if (preErrs.length)
    return {
      status: 2,
      message: preErrs
        .map((x) => `"${x.old}" -> "${x.next}": ${x.out.message}`)
        .join("; "),
      actions: [],
    };
  const actions: string[] = [];
  for (const { old, next } of changed) {
    const out = migrateOp(vaultDir, old, next, apply);
    if (out.status !== 0)
      return { status: out.status, message: out.message, actions };
    actions.push(`rename "${old}" -> "${next}"`, ...out.actions);
  }
  return {
    status: 0,
    message: apply
      ? `renamed ${changed.length} skill(s)`
      : "dry-run — nothing changed",
    actions,
  };
}

export function archiveOp(
  vaultDir: string,
  name: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!name) {
    return {
      status: 2,
      message: "usage: skill-loom archive <name> [--apply]",
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  const skill = scanVault(vaultDir, cfg).find((s) => s.name === name);
  if (!skill) {
    return {
      status: 2,
      message: `skill "${name}" not found in vault`,
      actions: [],
    };
  }
  const dest = path.join(vaultDir, ARCHIVE_DIR, name);
  if (existsSync(dest)) {
    return { status: 2, message: `${dest} already exists`, actions: [] };
  }
  const links = resolveConsumers(cfg)
    .filter((c) => c.dir !== null)
    .map((c) => path.join(c.dir as string, name))
    // Only unlink symlinks that actually resolve to THIS skill; a foreign
    // same-named link (another vault's skill) must be left alone.
    .filter((t) => {
      const st = lstatSync(t, { throwIfNoEntry: false });
      return st?.isSymbolicLink() && resolveLink(t) === path.resolve(skill.dir);
    });
  const actions = [
    `move ${skill.dir} -> ${dest}`,
    ...links.map((l) => `unlink ${l}`),
  ];
  if (!apply) {
    return { status: 0, message: "dry-run — nothing changed", actions };
  }
  // Archiving is a pure move: the skill folder goes to .archive/ and its runtime
  // links are removed. The archive view derives entirely from that folder, so we
  // never write an entry to loom.json.
  for (const l of links) unlinkSync(l);
  mkdirSync(path.dirname(dest), { recursive: true });
  renameSync(skill.dir, dest);
  return {
    status: 0,
    message: `archived "${name}" (${links.length} link(s) removed)`,
    actions,
  };
}

export function migrateOp(
  vaultDir: string,
  oldName: string | undefined,
  newName: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!oldName || !newName) {
    return {
      status: 2,
      message: "usage: skill-loom migrate <old> <new> [--apply]",
      actions: [],
    };
  }
  if (!NAME_RE.test(newName)) {
    return {
      status: 2,
      message: `invalid new name "${newName}" — must match ${NAME_RE}`,
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const skill = skills.find((s) => s.name === oldName);
  if (!skill) {
    return {
      status: 2,
      message: `skill "${oldName}" not found in vault`,
      actions: [],
    };
  }
  if (skills.some((s) => s.name === newName)) {
    return {
      status: 2,
      message: `skill "${newName}" already exists in vault`,
      actions: [],
    };
  }
  const newDir = path.join(path.dirname(skill.dir), newName);
  if (existsSync(newDir)) {
    return { status: 2, message: `${newDir} already exists`, actions: [] };
  }
  const actions = [
    `rename ${skill.dir} -> ${newDir}`,
    `set SKILL.md frontmatter name: ${newName}`,
    `re-link "${newName}" in ${Object.keys(cfg.consumers).length} consumer(s)`,
  ];
  if (!apply) {
    return { status: 0, message: "dry-run — nothing changed", actions };
  }
  renameSync(skill.dir, newDir);
  const mdPath = path.join(newDir, "SKILL.md");
  // Scope the name rewrite to the frontmatter block; a whole-file regex would
  // hit a body line starting with `name:` when the frontmatter has none.
  const migrated = setFrontmatterField(
    readFileSync(mdPath, "utf8"),
    "name",
    newName,
  );
  if (migrated !== null) writeFileSync(mdPath, migrated);
  for (const c of resolveConsumers(cfg)) {
    if (c.dir === null) continue;
    const oldTarget = path.join(c.dir, oldName);
    // skill.dir still holds the pre-rename path; only unlink the link that
    // actually pointed at it, never a foreign same-named symlink.
    const st = lstatSync(oldTarget, { throwIfNoEntry: false });
    if (
      st?.isSymbolicLink() &&
      resolveLink(oldTarget) === path.resolve(skill.dir)
    )
      unlinkSync(oldTarget);
  }
  applyPlan(
    planLinks(
      [
        {
          name: newName,
          dir: newDir,
          frontmatterName: newName,
          status: skill.status,
        },
      ],
      cfg,
    ),
  );
  return {
    status: 0,
    message: `migrated "${oldName}" -> "${newName}"`,
    actions,
  };
}

export function restoreOp(
  vaultDir: string,
  name: string | undefined,
  apply: boolean,
): OpOutcome {
  if (!name) {
    return {
      status: 2,
      message: "usage: skill-loom restore <name>",
      actions: [],
    };
  }
  if (!NAME_RE.test(name)) {
    return {
      status: 2,
      message: `invalid skill name "${name}" — must match ${NAME_RE}`,
      actions: [],
    };
  }
  const cfg = loadConfig(vaultDir);
  const src = path.join(vaultDir, ARCHIVE_DIR, name);
  if (!existsSync(src)) {
    return { status: 2, message: `no archived skill "${name}"`, actions: [] };
  }
  const dest = path.join(vaultDir, name);
  if (existsSync(dest)) {
    return { status: 2, message: `${dest} already exists`, actions: [] };
  }
  const consumers = Object.keys(cfg.consumers).length;
  const actions = [
    `move ${src} -> ${dest}`,
    `re-link "${name}" into ${consumers} consumer(s)`,
  ];
  if (!apply) {
    return { status: 0, message: "dry-run — nothing changed", actions };
  }
  renameSync(src, dest);
  const status =
    parseFrontmatterField(path.join(dest, "SKILL.md"), "status") ?? "active";
  applyPlan(
    planLinks([{ name, dir: dest, frontmatterName: name, status }], cfg),
  );
  return { status: 0, message: `restored "${name}"`, actions };
}
