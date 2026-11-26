import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { UsageError, gitFailureMessage } from "../errors.js";
import { table, yellow } from "../output.js";
import { loadConfig, type LossAcceptance } from "../config.js";
import {
  extractProtected,
  headings,
  words,
  baselineFingerprint,
  isAccepted,
  findStaleAcceptance,
} from "../loss.js";
import { runLossAccept } from "./loss-accept.js";

interface Options {
  base: string;
  minWordRetention: number;
  paths: string[];
  /** legacy path -> one or more successor paths (one-to-many split). */
  maps: Map<string, string[]>;
  termMaps: Map<string, string>;
}

interface Row {
  file: string;
  status: "ok" | "warn";
  oldWords: number;
  newWords: number;
  retainedPct: number;
  lostHeadings: number;
  lostProtected: string[];
  staleProtected: string[];
  note: string;
}

/** A bad --base or a missing path is a user error, not a program crash: wrap
 *  the shell-out and rethrow as a UsageError (exit 2) carrying git's own
 *  first-line diagnosis plus the args that failed, instead of letting the
 *  raw execFileSync stack trace escape uncaught (main.ts only catches
 *  UsageError; anything else propagates to a Node stack trace, exit 1). */
function git(vaultDir: string, args: string[]): string {
  const fullArgs = ["-C", vaultDir, ...args];
  try {
    return execFileSync("git", fullArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new UsageError(gitFailureMessage(fullArgs, err));
  }
}

function parseArgs(args: string[]): Options {
  let base = "HEAD";
  let minWordRetention = 0.65;
  const paths: string[] = [];
  const maps = new Map<string, string[]>();
  const termMaps = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--base") {
      const v = args[++i];
      if (!v) throw new UsageError("--base requires a git revision");
      base = v;
    } else if (arg === "--min-word-retention") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v < 0 || v > 1)
        throw new UsageError(
          "--min-word-retention requires a number from 0 to 1",
        );
      minWordRetention = v;
    } else if (arg === "--map") {
      const v = args[++i];
      if (!v || !v.includes("="))
        throw new UsageError("--map requires old.md=new.md");
      const [oldPath, newPath] = v.split("=", 2);
      if (!oldPath.endsWith(".md") || !newPath.endsWith(".md"))
        throw new UsageError("--map requires markdown paths");
      // repeated --map old=X --map old=Y accumulates a one-to-many split
      const targets = maps.get(oldPath) ?? [];
      targets.push(newPath);
      maps.set(oldPath, targets);
    } else if (arg === "--map-term") {
      const v = args[++i];
      if (!v || !v.includes("="))
        throw new UsageError("--map-term requires old=new");
      const [oldTerm, newTerm] = v.split("=", 2);
      if (!oldTerm || !newTerm)
        throw new UsageError("--map-term requires non-empty old=new");
      termMaps.set(oldTerm, newTerm);
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown flag "${arg}"`);
    } else {
      paths.push(arg);
    }
  }
  return { base, minWordRetention, paths, maps, termMaps };
}

function oldMarkdownFiles(
  vaultDir: string,
  base: string,
  paths: string[],
): string[] {
  const query = paths.length ? paths : ["."];
  return git(vaultDir, ["ls-tree", "-r", "--name-only", base, "--", ...query])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".md"));
}

// --map-term is a TRANSIENT, per-run, reason-less, global-across-all-files
// rename assertion — it mirrors --map (which does the same for whole files)
// but for individual terms. It is a command-line flag, never written to
// loom.json: it covers exactly the files audited in this invocation and is
// gone the moment the command exits. This makes it structurally unable to
// silence a FUTURE run's new loss for that term — only `accept` can do that,
// because `accept` is content-bound (keyed to a baseline fingerprint),
// persisted (written to loom.json's lint.lossAcceptances), per-file, and
// requires a non-empty --reason. Use --map-term for "I just renamed this
// term across the diff I'm looking at right now"; use `accept` for "this
// loss is permanently fine, on record, with a reason." By design — do not
// change --map-term to persist or require a reason to make it behave more
// like `accept`.
function termIsCovered(
  term: string,
  newText: string,
  termMaps: Map<string, string>,
): boolean {
  if (newText.includes(term)) return true;
  const mapped = termMaps.get(term);
  return mapped != null && newText.includes(mapped);
}

/** 5-gram word shingles of a section body — the unit of comparison for
 *  "did this text move?". Word-level, so reflow and punctuation edits do not
 *  matter; 5 long, so ordinary phrases shared by unrelated documents do not
 *  collide. */
function shingles(text: string): Set<string> {
  const w = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 5 <= w.length; i++)
    out.add(w.slice(i, i + 5).join("\u0000"));
  return out;
}

/** Fraction of the ORIGINAL section that survives in a candidate. Asymmetric on
 *  purpose: absorbing a section into a much longer document must still count as
 *  the section having landed there. */
function overlap(src: Set<string>, dst: Set<string>): number {
  if (src.size === 0) return 0;
  let hit = 0;
  for (const s of src) if (dst.has(s)) hit++;
  return hit / src.size;
}

/** Below this, a section is too short for shingles to mean anything. */
const MIN_SHINGLES = 20;
/** Calibrated on real relocations in a 70-skill vault: a section moved AND
 *  reworded scored 64%, the neighbouring section of the same file 5%, and every
 *  unrelated section in the vault 0%. Anywhere in the wide empty band between
 *  works; 30% sits in the middle of it. */
const RELOCATION_THRESHOLD = 0.3;

/** Sections of a document: a heading and everything under it up to the next. */
function sections(text: string): { heading: string; body: string }[] {
  const out: { heading: string; body: string }[] = [];
  let heading = "";
  let body: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      body.push(line);
      continue;
    }
    if (!inFence && /^#{1,6}\s+\S/.test(line)) {
      if (heading) out.push({ heading, body: body.join("\n") });
      heading = line.trim();
      body = [];
    } else body.push(line);
  }
  if (heading) out.push({ heading, body: body.join("\n") });
  return out;
}

interface IndexedSection {
  file: string;
  heading: string;
  shingles: Set<string>;
}

/** Every section in the working tree, shingled, so a section lost by one file
 *  can be looked for in every other.
 *
 *  Without this the most ordinary refactor is invisible: move a whole section
 *  from one document to another and word retention stays high, no protected
 *  term goes missing, and the row reads `ok` — identical to the row you get
 *  when the section was simply deleted.
 *
 *  Matching on heading NAMES was tried first and is wrong: "## Workflow" exists
 *  in half a vault, so it claimed relocations into unrelated skills. Matching on
 *  exact body text was tried second and is useless: a moved section is almost
 *  always reworded on the way. Shingle overlap is what actually separates them. */
function sectionIndex(vaultDir: string): IndexedSection[] {
  const out: IndexedSection[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const abs = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, relPath);
      else if (e.name.endsWith(".md")) {
        let text;
        try {
          text = readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        for (const s of sections(text)) {
          const sh = shingles(s.body);
          if (sh.size >= MIN_SHINGLES)
            out.push({ file: relPath, heading: s.heading, shingles: sh });
        }
      }
    }
  };
  walk(vaultDir, "");
  return out;
}

function auditFile(
  vaultDir: string,
  base: string,
  file: string,
  minWordRetention: number,
  maps: Map<string, string[]>,
  termMaps: Map<string, string>,
  configuredTerms: string[],
  acceptances: LossAcceptance[],
  index: IndexedSection[],
): Row {
  const oldText = git(vaultDir, ["show", `${base}:${file}`]);
  // A legacy file may split across several successors (one-to-many). Its
  // content is preserved if a term survives in ANY successor, so we audit
  // against the concatenation of all target files.
  const isMapped = maps.has(file);
  const targets = maps.get(file) ?? [file];
  const newTexts = targets.map((t) => {
    const p = path.join(vaultDir, t);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  });
  const newText = newTexts.join("\n");
  const allMissing = newTexts.every((t) => t === "");
  const oldWords = words(oldText).length;
  const newWords = words(newText).length;
  const retainedPct =
    oldWords === 0 ? 100 : Math.round((newWords / oldWords) * 100);

  const newHeadingSet = new Set(headings(newText));
  const lostHeadingList = headings(oldText).filter(
    (h) => !newHeadingSet.has(h),
  );
  // A section whose heading is gone from this file: still here under a new
  // heading, landed in another file, or actually gone. Only the middle case is
  // reported — it is the one an exact measure can prove, and the one that used
  // to leave no trace at all. "Actually gone" is deliberately NOT claimed: a
  // rewrite is indistinguishable from a deletion by text alone, and rewriting
  // is what the tool this audit guards exists to do.
  const relocated: string[] = [];
  const newShingles = shingles(newText);
  for (const s of sections(oldText)) {
    if (newHeadingSet.has(s.heading)) continue;
    const sh = shingles(s.body);
    if (sh.size < MIN_SHINGLES) continue;
    if (overlap(sh, newShingles) >= RELOCATION_THRESHOLD) continue; // reworded in place
    let best: { file: string; score: number } | null = null;
    for (const cand of index) {
      if (targets.includes(cand.file)) continue;
      const score = overlap(sh, cand.shingles);
      if (score >= RELOCATION_THRESHOLD && (!best || score > best.score))
        best = { file: cand.file, score };
    }
    if (best)
      relocated.push(
        `${s.heading} -> ${best.file} (${Math.round(best.score * 100)}%)`,
      );
  }

  // The acceptance is keyed on the LEGACY path (the baseline file), which is
  // also what the `accept` verb hashes (`git show base:<file>`). This makes an
  // acceptance content-bound: if the baseline text changes, `fp` no longer
  // matches and the acceptance goes stale.
  const fp = baselineFingerprint(oldText);
  const lostAll = extractProtected(oldText, configuredTerms).filter(
    (t) => !termIsCovered(t, newText, termMaps),
  );
  const lostProtected: string[] = [];
  const staleProtected: string[] = [];
  for (const t of lostAll) {
    if (isAccepted(file, t, fp, acceptances)) continue; // silenced, fresh baseline
    if (findStaleAcceptance(file, t, fp, acceptances)) staleProtected.push(t);
    else lostProtected.push(t);
  }

  const unaccepted = lostProtected.length + staleProtected.length;
  const status: Row["status"] =
    allMissing ||
    (oldWords > 80 && newWords / oldWords < minWordRetention) ||
    unaccepted > 0
      ? "warn"
      : "ok";

  const notes: string[] = [];
  if (isMapped) notes.push(`mapped to ${targets.join(", ")}`);
  if (allMissing) notes.push("missing in working tree");
  if (oldWords > 80 && newWords / oldWords < minWordRetention)
    notes.push(`word retention < ${Math.round(minWordRetention * 100)}%`);
  if (relocated.length) notes.push(`relocated: ${relocated.join("; ")}`);
  if (lostHeadingList.length)
    notes.push(`heading changes: ${lostHeadingList.length}`);
  if (lostProtected.length) notes.push(`lost: ${lostProtected.join(", ")}`);
  if (staleProtected.length)
    notes.push(`stale acceptance: ${staleProtected.join(", ")}`);

  return {
    file: isMapped ? `${file} -> ${targets.join(", ")}` : file,
    status,
    oldWords,
    newWords,
    retainedPct,
    lostHeadings: lostHeadingList.length,
    lostProtected,
    staleProtected,
    note: notes.join("; "),
  };
}

export function runLossAudit(vaultDir: string, args: string[]): number {
  if (args[0] === "accept") return runLossAccept(vaultDir, args.slice(1));
  const opts = parseArgs(args);
  const cfg = loadConfig(vaultDir);
  const configuredTerms = cfg.lint?.protectedTerms ?? [];
  const acceptances = cfg.lint?.lossAcceptances ?? [];

  const files = oldMarkdownFiles(vaultDir, opts.base, opts.paths);
  // Built once for the run: a section lost by one file may have landed in any
  // other, so the search has to span the vault, not the audited subset.
  const index = sectionIndex(vaultDir);
  const rows = files.map((f) =>
    auditFile(
      vaultDir,
      opts.base,
      f,
      opts.minWordRetention,
      opts.maps,
      opts.termMaps,
      configuredTerms,
      acceptances,
      index,
    ),
  );

  if (rows.length === 0) {
    console.log("no markdown files found in baseline");
    return 0;
  }

  console.log(
    table([
      [
        "status",
        "file",
        "old",
        "new",
        "retained",
        "head-chg",
        "lost",
        "stale",
        "note",
      ],
      ...rows.map((r) => [
        r.status,
        r.file,
        String(r.oldWords),
        String(r.newWords),
        `${r.retainedPct}%`,
        String(r.lostHeadings),
        String(r.lostProtected.length),
        String(r.staleProtected.length),
        r.note,
      ]),
    ]),
  );

  const warnings = rows.filter((r) => r.status === "warn").length;
  if (warnings) {
    console.error(
      yellow(
        `${warnings} file(s) need content-loss review — restore, map terms, or explicitly accept ` +
          `(skill-loom loss-audit accept <file> --term <t> --reason "...") before calling the refactor complete`,
      ),
    );
  }
  return warnings === 0 ? 0 : 1;
}
