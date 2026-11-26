export class UsageError extends Error {}

/** Reduce an execFileSync git failure to one clean line: git's own stderr
 *  (its first non-empty line) when available, falling back to the error
 *  message. Shared by loss-audit.ts and loss-accept.ts so a bad --base or a
 *  missing path surfaces as a UsageError one-liner, not a raw Node stack
 *  trace with an embedded multi-line git error. */
export function gitFailureMessage(args: string[], err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  const raw =
    (typeof stderr === "string" && stderr) ||
    (err instanceof Error ? err.message : String(err));
  const firstLine =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "git failed";
  return `git ${args.join(" ")}: ${firstLine}`;
}
