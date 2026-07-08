import { syncOp } from "../sync.js";
import { dim } from "../output.js";

export function runSync(vaultDir: string, apply: boolean): number {
  const out = syncOp(vaultDir, apply);
  if (out.status !== 0) {
    console.error(out.message);
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
