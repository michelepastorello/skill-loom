// Regenerate the demo vault used for the README screenshots.
//
//   node demo/scaffold-demo.mjs
//   skill-loom ui --port 7777        # from demo/demo-vault, then open the dashboard
//
// Everything is relative to this file, so the vault is fully relocatable — no
// absolute paths are baked in. The generated demo/demo-vault/ is gitignored;
// this script is the source of truth. See demo/README.md.

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "demo-vault",
);
rmSync(ROOT, { recursive: true, force: true });

// [category, name, icon, icon-color, description]
const SKILLS = [
  // engineering
  [
    "engineering",
    "code-review",
    "git-branch",
    null,
    "Review a diff for correctness, security, and style, then suggest the smallest fix for each finding.",
  ],
  [
    "engineering",
    "commit-message",
    "git-commit",
    null,
    "Write a clear conventional-commit message from a staged diff — subject, body, and footer.",
  ],
  [
    "engineering",
    "test-generator",
    "clipboard-check",
    "cyan-600",
    "Generate focused unit tests for a function, covering happy path, edges, and error cases.",
  ],
  [
    "engineering",
    "api-docs",
    "file-text",
    null,
    "Turn a route or function signature into clean reference docs with examples.",
  ],
  [
    "engineering",
    "sql-review",
    "database",
    null,
    "Explain and optimize a SQL query: indexes, N+1s, and safer rewrites.",
  ],
  [
    "engineering",
    "dockerfile",
    "package",
    null,
    "Draft a small, layer-cached Dockerfile for a project, with a multi-stage build.",
  ],
  // writing
  [
    "writing",
    "changelog",
    "list-checks",
    "emerald-500",
    "Assemble a human-readable changelog from merged commits, grouped by type.",
  ],
  [
    "writing",
    "release-notes",
    "megaphone",
    null,
    "Write release notes for a version: highlights, breaking changes, upgrade steps.",
  ],
  [
    "writing",
    "blog-draft",
    "feather",
    null,
    "Draft a technical blog post from an outline, in a plain, no-hype voice.",
  ],
  [
    "writing",
    "readme-polish",
    "book-open",
    null,
    "Tighten a README: clear intro, working quickstart, honest scope.",
  ],
  // research
  [
    "research",
    "paper-summary",
    "sparkles",
    null,
    "Summarize a paper into claim, method, and what it means for your work.",
  ],
  [
    "research",
    "market-brief",
    "bar-chart",
    "sky-600",
    "Turn scattered notes into a short, sourced market brief.",
  ],
  [
    "research",
    "competitor-scan",
    "search",
    null,
    "Compare N products across the axes that matter, with a recommendation.",
  ],
];

const F = "```"; // code fence, kept out of the template literals below

// code-review is the one multi-file skill — it carries the file-panel demo.
const CR_BASE = `
# code-review

Review the current change for bugs, security issues, and clarity — and propose the smallest fix that resolves each finding.

## When to use

- A pull request or local diff is ready for a second pass
- You want a focused review, not a rewrite
- Before merging anything that touches auth, money, or user data

## What it checks

1. **Correctness** — off-by-one, null handling, error paths, race conditions.
2. **Security** — injection, secrets in code, unsafe deserialization.
3. **Clarity** — naming, dead code, functions doing two things.

## Output

A short list, most-severe first:

${F}
file:line — problem  →  suggested fix
${F}
`;

const CR_CHECKLIST = `
## Security checklist

- No secrets committed
- Inputs validated at the boundary
- Errors never swallow the stack
`;

const CR_ENRICHED = `${CR_BASE}
## Run it

${F}bash
pip install -r requirements.txt
python scripts/run-review.py --diff HEAD~1
${F}

## Reference

Full pre-merge audit lives in [\`references/checklist.md\`](references/checklist.md) —
correctness, security, and clarity gates to run before approving.
`;

const CHECKLIST_MD = `# Pre-merge review checklist

Run through this before approving anything that touches auth, money, or user data.

## Correctness

- [ ] Off-by-one and boundary conditions checked
- [ ] Null, empty, and error paths handled
- [ ] No race conditions on shared state

## Security

- [ ] No secrets or credentials committed
- [ ] All inputs validated at the boundary
- [ ] No unsafe deserialization of untrusted data
- [ ] Errors never swallow the stack trace

## Clarity

- [ ] Names say what they mean
- [ ] No dead code left behind
- [ ] Each function does one thing
`;

const RUN_REVIEW_PY = `#!/usr/bin/env python3
"""Print a review skeleton for a git diff — one line per changed hunk."""
import argparse
import subprocess

from unidiff import PatchSet


def changed_hunks(diff_range: str) -> PatchSet:
    raw = subprocess.run(
        ["git", "diff", diff_range],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return PatchSet(raw)


def main() -> None:
    ap = argparse.ArgumentParser(description="Scaffold a review for a diff.")
    ap.add_argument("--diff", default="HEAD~1", help="git diff range to review")
    args = ap.parse_args()

    for patched in changed_hunks(args.diff):
        for hunk in patched:
            print(f"{patched.path}:{hunk.target_start} — review  →  ")


if __name__ == "__main__":
    main()
`;

// Orthogonal taxonomy for the demo: domain groups the skills, layer is the kind
// of work each one does. A spread of lifecycle states shows all five chips (an
// absent status reads as active).
const LAYER = {
  "code-review": "review",
  "commit-message": "authoring",
  "test-generator": "automation",
  "api-docs": "authoring",
  "sql-review": "review",
  dockerfile: "automation",
  changelog: "automation",
  "release-notes": "authoring",
  "blog-draft": "authoring",
  "readme-polish": "review",
  "paper-summary": "analysis",
  "market-brief": "analysis",
  "competitor-scan": "analysis",
};
const STATUS = {
  "blog-draft": "draft",
  "market-brief": "draft",
  "paper-summary": "idea",
  "competitor-scan": "suspended",
  "sql-review": "deprecated",
};

function frontmatter(name, icon, color, desc, domain) {
  const fm = [`name: ${name}`, `domain: ${domain}`, `layer: ${LAYER[name]}`];
  if (STATUS[name]) fm.push(`status: ${STATUS[name]}`);
  fm.push(`icon: ${icon}`);
  if (color) fm.push(`icon-color: ${color}`);
  fm.push(`description: ${desc}`);
  return `---\n${fm.join("\n")}\n---`;
}

function genericBody(name, desc) {
  return `\n# ${name}\n\n${desc}\n\n## When to use\n\n- ${desc}\n\n## Steps\n\n1. Read the input.\n2. Apply the rules above.\n3. Return a concise result.\n`;
}

function git(args, date) {
  execFileSync(
    "git",
    [
      "-C",
      ROOT,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.name=skill-loom demo",
      "-c",
      "user.email=demo@skill-loom.local",
      ...args,
    ],
    {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      stdio: "pipe",
    },
  );
}

// ── commit 1: all skills, code-review still single-file ─────────────────────
// The vault is flat: one folder per skill at the root; `domain` (not a nested
// category directory) drives grouping.
for (const [cat, name, icon, color, desc] of SKILLS) {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  const body = name === "code-review" ? CR_BASE : genericBody(name, desc);
  writeFileSync(
    path.join(dir, "SKILL.md"),
    `${frontmatter(name, icon, color, desc, cat)}\n${body}`,
  );
}
// An in-place runtime reads its skill dirs from its own config instead of a
// symlinked directory; register the vault there so the detail page's in-place
// toggle reads as served.
const rtInplace = path.join(ROOT, ".rt/openclaw.json");
mkdirSync(path.dirname(rtInplace), { recursive: true });
writeFileSync(
  rtInplace,
  JSON.stringify({ skills: { load: { extraDirs: [ROOT] } } }, null, 2) + "\n",
);
writeFileSync(
  path.join(ROOT, "loom.json"),
  JSON.stringify(
    {
      schema: 1,
      consumers: {
        claude: path.join(ROOT, ".rt/claude"),
        codex: path.join(ROOT, ".rt/codex"),
        openclaw: {
          mode: "in-place",
          servedVia: { file: rtInplace, jsonPath: "skills.load.extraDirs" },
        },
      },
      ignore: [".git", "node_modules", ".rt"],
    },
    null,
    2,
  ) + "\n",
);
git(["init", "-q", "-b", "main"]);
git(["add", "-A"]);
git(
  ["commit", "-q", "-m", "feat: engineering, writing and research skills"],
  "2026-07-08T10:00:00",
);

// ── commit 2: add a security checklist to code-review ───────────────────────
const crSkill = path.join(ROOT, "code-review/SKILL.md");
appendFileSync(crSkill, CR_CHECKLIST);
git(["add", "-A"]);
git(
  ["commit", "-q", "-m", "code-review: add a security checklist"],
  "2026-07-08T15:00:00",
);

// ── commit 3: extract checklist to references, add the review runner ────────
const crDir = path.join(ROOT, "code-review");
writeFileSync(
  crSkill,
  `${frontmatter("code-review", "git-branch", null, SKILLS[0][4], "engineering")}\n${CR_ENRICHED}`,
);
mkdirSync(path.join(crDir, "references"), { recursive: true });
writeFileSync(path.join(crDir, "references/checklist.md"), CHECKLIST_MD);
mkdirSync(path.join(crDir, "scripts"), { recursive: true });
writeFileSync(path.join(crDir, "scripts/run-review.py"), RUN_REVIEW_PY);
writeFileSync(path.join(crDir, "requirements.txt"), "unidiff>=0.7.5\n");
git(["add", "-A"]);
git(
  [
    "commit",
    "-q",
    "-m",
    "code-review: extract checklist to references, add review runner",
  ],
  "2026-07-09T09:00:00",
);

// ── light up the runtime toggles (best-effort) ──────────────────────────────
try {
  execFileSync("skill-loom", ["link", "--apply"], { cwd: ROOT, stdio: "pipe" });
  console.log("linked into claude + codex runtimes");
} catch {
  console.log(
    "run `skill-loom link --apply` in demo-vault to light up the runtime toggles",
  );
}

console.log(`scaffolded ${SKILLS.length} skills at ${ROOT}`);
