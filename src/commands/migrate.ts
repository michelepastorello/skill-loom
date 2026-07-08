import { migrateOp } from "../ops.js";
import { dim } from "../output.js";

export function runMigrate(
  vaultDir: string,
  oldName: string | undefined,
  newName: string | undefined,
  apply: boolean,
): number {
  const out = migrateOp(vaultDir, oldName, newName, apply);
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
