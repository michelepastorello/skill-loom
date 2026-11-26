/** Preservation engine: pure, no I/O, no private vocabulary.
 *  Extractors mirror the doctrine in skill-refactor/references/preservation-rules.md
 *  (commands, examples, APIs, numbers, rules, cases, tables, guardrails, decisions)
 *  but only through GENERIC structural categories. Domain vocabulary is supplied
 *  by the caller from loom.json lint.protectedTerms. */

import { createHash } from "node:crypto";
import type { LossAcceptance } from "./config.js";

export function words(text: string): string[] {
  return text.match(/[A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9_./€%+-]*/g) ?? [];
}

/** Markdown headings, ignoring fenced code blocks.
 *
 *  A shell comment inside ```bash — `# 2. pack the tarball` — is not a heading,
 *  but it matched the same regex, so it entered the heading list, inflated the
 *  "heading changes" count and turned up as a lost section. */
export function headings(text: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#{1,6}\s+\S/.test(line)) out.push(line.trim());
  }
  return out;
}

/** One entry per markdown table (its header row), detected by a header line
 *  immediately followed by a delimiter row of pipes and dashes. */
export function tables(text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (
      /\|/.test(lines[i]) &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].includes("-")
    ) {
      out.push(lines[i].trim());
    }
  }
  return out;
}

/** Protected tokens present in `text`. Structural categories only, plus any
 *  configured domain term literally present. Never invents domain vocabulary. */
export function extractProtected(
  text: string,
  configuredTerms: string[],
): string[] {
  const terms = new Set<string>();
  // Single-token code spans: `foo` but not `foo bar`.
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const v = m[1].trim();
    if (v && !v.includes(" ")) terms.add(v);
  }
  // Numbers, currency, percentages, durations. Keep the token exactly as it
  // appears in the text (only trim edges) — coverage is a literal
  // `newText.includes(term)`, so normalizing internal whitespace here (e.g.
  // "2 ore" -> "2ore") would make the token never match its own unchanged text
  // and report a false loss.
  for (const m of text.matchAll(
    /(?:€\s?[0-9][0-9.,kK+-]*|[0-9]+(?:[.,][0-9]+)?%|[0-9]+(?:[.,][0-9]+)?\s?(?:giorni|settimane|mesi|ore|h|k|M)\b|[0-9]+(?:[.,][0-9]+)?)/gi,
  )) {
    terms.add(m[0].trim());
  }
  // ALL-CAPS acronyms of length >= 3 (API, MCP, GDPR, HTTP, GET, POST...).
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
    terms.add(m[0]);
  }
  // Vault-declared domain terms literally present. The list is the vault's.
  for (const t of configuredTerms) {
    if (t && text.includes(t)) terms.add(t);
  }
  return [...terms].sort();
}

export function baselineFingerprint(oldText: string): string {
  return createHash("sha256").update(oldText, "utf8").digest("hex");
}

export function isAccepted(
  file: string,
  term: string,
  oldFingerprint: string,
  acceptances: LossAcceptance[],
): boolean {
  return acceptances.some(
    (a) =>
      a.file === file &&
      a.term === term &&
      a.reason.trim().length > 0 &&
      a.baseline === oldFingerprint,
  );
}

export function findStaleAcceptance(
  file: string,
  term: string,
  oldFingerprint: string,
  acceptances: LossAcceptance[],
): LossAcceptance | undefined {
  return acceptances.find(
    (a) => a.file === file && a.term === term && a.baseline !== oldFingerprint,
  );
}
