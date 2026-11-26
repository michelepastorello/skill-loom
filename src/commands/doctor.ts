import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { green, red, yellow } from "../output.js";
import { syncStatus } from "../sync.js";
import { collectDoctor } from "../gate.js";
import { loadConfig } from "../config.js";
import { scanVault, parseFrontmatterField } from "../vault.js";

/** A repo can carry its hooks in a tracked directory, but git only runs them if
 *  core.hooksPath points there — and that setting lives in .git/config, which no
 *  clone inherits. So the hooks travel with the repo and their activation does
 *  not: on a second machine they simply never fire, and nothing says so. That is
 *  not hypothetical — a vault kept its knowledge-graph refresh in .githooks and
 *  spent days assuming it ran everywhere it was checked out. */
function inactiveHooks(vaultDir: string): string | null {
  const dir = path.join(vaultDir, ".githooks");
  if (!existsSync(dir)) return null;
  let hooks: string[];
  try {
    hooks = readdirSync(dir).filter((f) => !f.endsWith(".sample"));
  } catch {
    return null;
  }
  if (hooks.length === 0) return null;
  const cfg = spawnSync("git", ["-C", vaultDir, "config", "core.hooksPath"], {
    encoding: "utf8",
  });
  const configured = cfg.status === 0 ? cfg.stdout.trim() : "";
  if (configured === ".githooks" || configured === dir) return null;
  return (
    `hooks: .githooks/ ships ${hooks.length} hook(s) (${hooks.join(", ")}) but core.hooksPath is ` +
    `${configured ? `"${configured}"` : "unset"} — git is not running them. ` +
    `Run "git config core.hooksPath .githooks" in this clone.`
  );
}

/** Sum of the descriptions that get projected into a runtime, in characters. */
function descriptionBudget(vaultDir: string): number {
  try {
    const cfg = loadConfig(vaultDir);
    return scanVault(vaultDir, cfg)
      .filter(
        (s) =>
          !["suspended", "deprecated", "idea"].includes(s.status ?? "active"),
      )
      .reduce((n, s) => {
        const d = parseFrontmatterField(
          path.join(s.dir, "SKILL.md"),
          "description",
        );
        return n + (d?.length ?? 0);
      }, 0);
  } catch {
    return 0;
  }
}

export function runDoctor(vaultDir: string): number {
  const { count, blocking, warnings } = collectDoctor(vaultDir);
  for (const b of blocking) console.error(red(b));
  for (const w of warnings) console.error(yellow(w));
  console.log(
    count === 0 ? green("vault healthy") : `${count} problem(s) found`,
  );
  // Il costo delle description e' un TOTALE, non un per-skill: finiscono in
  // system prompt a ogni lancio, quindi si paga la somma una volta per
  // sessione. Si misura e basta — un budget bloccante farebbe fallire il vault
  // per colpa di una skill terza, e la reazione sarebbe limare a caso.
  const budget = descriptionBudget(vaultDir);
  if (budget > 0)
    console.log(
      `description budget: ${budget} chars ≈ ${Math.round(budget / 4)} tokens per session`,
    );
  const hooks = inactiveHooks(vaultDir);
  if (hooks) console.error(yellow(hooks));
  const sync = syncStatus(vaultDir);
  if (sync.versioned && sync.remote && !sync.upstream) {
    // Reporting "0 ahead / 0 behind" here would be worse than saying nothing:
    // the numbers are not zero, they are unmeasurable, and the two read the
    // same to anyone glancing at the line.
    console.log(
      `sync: ${sync.dirty} uncommitted, ahead/behind UNKNOWN — this branch has no upstream. ` +
        `Run "git branch --set-upstream-to=origin/<branch>" or the divergence stays invisible.`,
    );
  } else if (
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
