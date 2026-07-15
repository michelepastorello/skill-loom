import { addOp, type AddOptions } from "../ops.js";

export function runAdd(
  vaultDir: string,
  name: string | undefined,
  opts: AddOptions,
): number {
  const out = addOp(vaultDir, name, opts, true);
  if (out.status === 0) console.log(out.message);
  else console.error(out.message);
  return out.status;
}
