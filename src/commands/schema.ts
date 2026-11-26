import { loadConfig, resolveAxes } from "../config.js";
import { STATUSES, isProjectedStatus } from "../vault.js";

/** Bump when a field changes meaning or disappears. The vault's gate parses
 *  this, so it is a contract with a consumer, not a debug dump. */
export const SCHEMA_CONTRACT = 1;

export function runSchema(vaultDir: string): number {
  const cfg = loadConfig(vaultDir);
  const axes = resolveAxes(cfg);
  const byId = (id: string): string[] | null =>
    axes.find((a) => a.id === id)?.values ?? null;
  console.log(
    JSON.stringify(
      {
        contract: SCHEMA_CONTRACT,
        // skill-loom's own: which statuses exist, and which of them it projects
        lifecycle: {
          statuses: [...STATUSES],
          projected: STATUSES.filter((s) => isProjectedStatus(s)),
        },
        // The vault's own. `axes` is the current shape; `domains`/`layers` stay
        // for contract-1 consumers (the vault's gate.py reads them and exits on
        // a missing key). They are derived BY AXIS ID, never by position: a
        // vault declaring domain/area/kind must report layers: null, not the
        // area vocabulary under a layer label.
        taxonomy: {
          domains: byId("domain"),
          layers: byId("layer"),
          axes: axes.map((a) => ({
            id: a.id,
            ...(a.label ? { label: a.label } : {}),
            values: a.values ?? null,
          })),
        },
      },
      null,
      2,
    ),
  );
  return 0;
}
