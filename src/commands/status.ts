import { loadConfig } from "../config.js";
import { scanVault } from "../vault.js";
import { statusMatrix } from "../linker.js";
import { table } from "../output.js";

export function runStatus(vaultDir: string): number {
  const cfg = loadConfig(vaultDir);
  const skills = scanVault(vaultDir, cfg);
  const consumers = Object.keys(cfg.consumers);
  const matrix = statusMatrix(skills, cfg);
  const rows: string[][] = [
    ["SKILL", ...consumers.map((c) => c.toUpperCase())],
  ];
  for (const skill of skills) {
    rows.push([
      skill.name,
      ...consumers.map(
        (c) =>
          matrix.find((m) => m.skill === skill.name && m.consumer === c)
            ?.state ?? "?",
      ),
    ]);
  }
  console.log(table(rows));
  console.log(`${skills.length} skill(s), ${consumers.length} consumer(s)`);
  return 0;
}
