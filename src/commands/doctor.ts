import { green, red, yellow } from "../output.js";
import { syncStatus } from "../sync.js";
import { collectDoctor } from "../gate.js";

export function runDoctor(vaultDir: string): number {
  const { count, blocking, warnings } = collectDoctor(vaultDir);
  for (const b of blocking) console.error(red(b));
  for (const w of warnings) console.error(yellow(w));
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
