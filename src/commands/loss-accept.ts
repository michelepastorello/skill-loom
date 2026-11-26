import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsageError, gitFailureMessage } from "../errors.js";
import { green } from "../output.js";
import { loadConfig, saveConfig, type LossAcceptance } from "../config.js";
import { baselineFingerprint } from "../loss.js";

export function runLossAccept(vaultDir: string, args: string[]): number {
  let base = "HEAD";
  let term = "";
  let reason = "";
  let dropped = false;
  const verifiedIn: string[] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--term") term = args[++i] ?? "";
    else if (a === "--reason") reason = args[++i] ?? "";
    else if (a === "--base") base = args[++i] ?? "";
    else if (a === "--verified-in") verifiedIn.push(args[++i] ?? "");
    else if (a === "--dropped") dropped = true;
    else if (a.startsWith("--")) throw new UsageError(`unknown flag "${a}"`);
    else files.push(a);
  }
  if (files.length !== 1)
    throw new UsageError("accept requires exactly one file path");
  if (!term) throw new UsageError("accept requires --term <term>");
  if (reason.trim().length === 0)
    throw new UsageError(
      "accept requires a non-empty --reason (auto-generation is forbidden)",
    );

  // A reason is prose: it can claim the term "moved to X" and be wrong, and
  // nothing here used to check. That is the one failure this whole audit exists
  // to prevent — content gone, an accept on top, three gates green. So the
  // author must now say which of the two it is, in a form the tool can test:
  // name the file where the term survives, or state outright that it is gone.
  if (dropped && verifiedIn.length > 0)
    throw new UsageError(
      "accept takes --verified-in or --dropped, not both: either the term survives somewhere or it does not",
    );
  if (!dropped && verifiedIn.length === 0)
    throw new UsageError(
      `accept requires --verified-in <file> (where "${term}" survives — it is checked) ` +
        "or --dropped (the content is gone on purpose)",
    );

  const file = files[0];
  const showArgs = ["-C", vaultDir, "show", `${base}:${file}`];
  let oldText: string;
  try {
    oldText = execFileSync("git", showArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A bad --base or a path absent from the baseline is a user error, not a
    // program crash: surface it as a UsageError one-liner (main.ts -> exit
    // 2), not a raw execFileSync stack trace.
    throw new UsageError(gitFailureMessage(showArgs, err));
  }
  const baseline = baselineFingerprint(oldText);

  // Check the claim before recording it. Reading the working tree, not the
  // baseline: the question is whether the term survives NOW, at the destination
  // the author named.
  for (const dest of verifiedIn) {
    if (!dest) throw new UsageError("--verified-in requires a file path");
    const abs = join(vaultDir, dest);
    let destText: string;
    try {
      destText = readFileSync(abs, "utf8");
    } catch {
      throw new UsageError(
        `--verified-in ${dest}: no such file in the vault — name the file the term actually moved to`,
      );
    }
    if (!destText.includes(term))
      throw new UsageError(
        `--verified-in ${dest} does not contain "${term}". ` +
          "Either the term went somewhere else, or it did not survive — in which case say --dropped and mean it.",
      );
  }

  const cfg = loadConfig(vaultDir);
  cfg.lint = cfg.lint ?? {};
  const list: LossAcceptance[] = cfg.lint.lossAcceptances ?? [];
  const next: LossAcceptance = {
    file,
    term,
    reason: reason.trim(),
    baseline,
    ...(dropped ? { dropped: true as const } : { verifiedIn }),
  };
  const idx = list.findIndex((a) => a.file === file && a.term === term);
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  cfg.lint.lossAcceptances = list;
  saveConfig(vaultDir, cfg);

  console.log(
    green(
      dropped
        ? `accepted loss of "${term}" in ${file} as dropped (baseline ${baseline.slice(0, 12)})`
        : `accepted loss of "${term}" in ${file} — verified in ${verifiedIn.join(", ")} (baseline ${baseline.slice(0, 12)})`,
    ),
  );
  return 0;
}
