import { loadConfig } from "../config.js";
import { scanVault, validateVault } from "../vault.js";
import {
  applyPlan,
  planAgentLinks,
  planLinks,
  planOrphanLinks,
} from "../linker.js";
import { dim, green, red, yellow } from "../output.js";

export function runLink(vaultDir: string, apply: boolean): number {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const problems = validateVault(skills);
  if (problems.length > 0) {
    for (const p of problems) console.error(red(`${p.kind}: ${p.detail}`));
    console.error(`${problems.length} vault problem(s) — fix before linking`);
    return 1;
  }
  // Skills and the agents they ship are one projection: a runtime that reads
  // both roots is only whole when both are linked, so one command plans both.
  const items = [
    ...planLinks(skills, cfg),
    ...planAgentLinks(skills, cfg),
    ...planOrphanLinks(vaultDir, cfg, skills),
  ];
  for (const i of items) {
    if (i.action === "ok") continue;
    const label =
      i.action === "conflict"
        ? red("conflict")
        : i.action === "create"
          ? green("create")
          : i.action === "remove-orphan"
            ? yellow("remove-orphan")
            : yellow("replace-stale");
    console.log(
      `${label}  ${i.target}  ${dim(`-> ${i.source}`)}${i.detail ? `  (${i.detail})` : ""}`,
    );
  }
  const creates = items.filter((i) => i.action === "create").length;
  const replaces = items.filter((i) => i.action === "replace-stale").length;
  const removals = items.filter((i) => i.action === "remove-orphan").length;
  const conflicts = items.filter((i) => i.action === "conflict").length;
  if (apply) {
    applyPlan(items);
    console.log(
      `applied: ${creates} created, ${replaces} replaced, ${removals} orphan(s) removed, ${conflicts} conflict(s) skipped`,
    );
  } else {
    console.log(
      dim(
        `dry-run: ${creates + replaces + removals} pending change(s), ${conflicts} conflict(s) — re-run with --apply`,
      ),
    );
  }
  return conflicts > 0 ? 1 : 0;
}
