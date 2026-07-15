import { syncOp } from "../sync.js";
import { dim } from "../output.js";

export function runSync(
  vaultDir: string,
  apply: boolean,
  force = false,
): number {
  const out = syncOp(vaultDir, apply, force);
  if (out.status !== 0) {
    console.error(out.message);
    if (out.gate) {
      for (const g of out.gate) console.error(`  - ${g}`);
      console.error("re-run with --force to commit anyway.");
    }
    return out.status;
  }
  if (out.actions.length === 0) {
    console.log(out.message);
    return 0;
  }
  for (const a of out.actions) console.log(apply ? a : `would ${a}`);
  console.log(apply ? out.message : dim("dry-run — re-run with --apply"));
  return 0;
}
