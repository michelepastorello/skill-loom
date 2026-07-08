import { loadConfig } from "../config.js";
import { scanVault, validateVault } from "../vault.js";
import { orphanLinks, statusMatrix } from "../linker.js";
import { green, red } from "../output.js";
import { syncStatus } from "../sync.js";

export function runDoctor(vaultDir: string): number {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const problems = validateVault(skills);
  const unhealthy = statusMatrix(skills, cfg).filter(
    (m) => m.state === "broken" || m.state === "foreign",
  );
  const orphans = orphanLinks(vaultDir, cfg, skills);
  for (const p of problems) console.error(red(`vault ${p.kind}: ${p.detail}`));
  for (const u of unhealthy)
    console.error(red(`consumer ${u.consumer}: "${u.skill}" is ${u.state}`));
  for (const o of orphans) console.error(red(`orphan link: ${o}`));
  const count = problems.length + unhealthy.length + orphans.length;
  console.log(
    count === 0 ? green("vault healthy") : `${count} problem(s) found`,
  );
  const sync = syncStatus(vaultDir);
  if (
    sync.versioned &&
    sync.remote &&
    (sync.ahead > 0 || sync.behind > 0 || sync.dirty > 0)
  ) {
    console.log(
      `sync: ${sync.dirty} uncommitted, ${sync.ahead} ahead / ${sync.behind} behind origin — run "skill-loom sync"`,
    );
  }
  return count === 0 ? 0 : 1;
}
