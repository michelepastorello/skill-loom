import { archiveOp } from "../ops.js";
import { dim } from "../output.js";

export function runArchive(
  vaultDir: string,
  name: string | undefined,
  apply: boolean,
): number {
  const out = archiveOp(vaultDir, name, apply);
  if (out.status !== 0) {
    console.error(out.message);
    return out.status;
  }
  if (!apply) {
    for (const a of out.actions) console.log(`would ${a}`);
    console.log(dim("dry-run — re-run with --apply"));
    return 0;
  }
  console.log(out.message);
  return 0;
}
