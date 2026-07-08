import { addOp } from "../ops.js";

export function runAdd(
  vaultDir: string,
  name: string | undefined,
  category: string | undefined,
): number {
  const out = addOp(vaultDir, name, category, undefined, true);
  if (out.status === 0) console.log(out.message);
  else console.error(out.message);
  return out.status;
}
