import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import type { OpOutcome } from "./ops.js";
import { collectDoctor } from "./gate.js";

export interface SyncStatus {
  versioned: boolean;
  remote: string | null;
  dirty: number;
  ahead: number;
  behind: number;
  /** Subjects of remote commits not yet pulled (newest first, capped). */
  incoming: string[];
  /** Subjects of local commits not yet pushed (newest first, capped). */
  outgoing: string[];
}

function git(vaultDir: string, ...args: string[]) {
  return spawnSync("git", ["-C", vaultDir, ...args], { encoding: "utf8" });
}

/**
 * Where the vault sits relative to git. `isRoot` is true only when vaultDir is
 * the top level of its own repo — not merely nested inside a larger one. Every
 * git-mutating path guards on this so we never operate on a parent repo (e.g.
 * the home dir), which would list and commit unrelated files.
 */
export function vaultRepo(vaultDir: string): {
  inside: boolean;
  isRoot: boolean;
  root: string | null;
} {
  const top = git(vaultDir, "rev-parse", "--show-toplevel");
  if (top.error || top.status !== 0) {
    return { inside: false, isRoot: false, root: null };
  }
  const root = top.stdout.trim();
  let isRoot = false;
  try {
    isRoot = realpathSync(root) === realpathSync(vaultDir);
  } catch {
    isRoot = false;
  }
  return { inside: true, isRoot, root };
}

export function syncStatus(vaultDir: string, fetchFirst = false): SyncStatus {
  // Only treat the vault as versioned when it is the ROOT of its own repo.
  // If it merely sits inside a larger repo (e.g. the home dir), git would
  // report that repo's whole status — never surface that as the vault's.
  if (!vaultRepo(vaultDir).isRoot) {
    return {
      versioned: false,
      remote: null,
      dirty: 0,
      ahead: 0,
      behind: 0,
      incoming: [],
      outgoing: [],
    };
  }
  const remoteOut = git(vaultDir, "remote", "get-url", "origin");
  const remote = remoteOut.status === 0 ? remoteOut.stdout.trim() : null;
  const dirty = git(vaultDir, "status", "--porcelain")
    .stdout.split("\n")
    .filter(Boolean).length;
  let ahead = 0;
  let behind = 0;
  let incoming: string[] = [];
  let outgoing: string[] = [];
  if (remote) {
    if (fetchFirst) git(vaultDir, "fetch", "--quiet", "origin");
    const counts = git(
      vaultDir,
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    );
    if (counts.status === 0) {
      const [a = "0", b = "0"] = counts.stdout.trim().split(/\s+/);
      ahead = Number(a);
      behind = Number(b);
    }
    const subjects = (range: string) => {
      const out = git(vaultDir, "log", "--format=%s", "-n", "8", range);
      return out.status === 0 ? out.stdout.split("\n").filter(Boolean) : [];
    };
    if (behind > 0) incoming = subjects("HEAD..@{upstream}");
    if (ahead > 0) outgoing = subjects("@{upstream}..HEAD");
  }
  return { versioned: true, remote, dirty, ahead, behind, incoming, outgoing };
}

// File paths involved in each pending sync direction, for per-skill
// indicators: uncommitted paths, paths touched by commits not yet pushed,
// and paths touched by commits not yet pulled (as of the last fetch).
export interface SyncFiles {
  dirty: string[];
  outgoing: string[];
  incoming: string[];
}

export function syncFiles(vaultDir: string): SyncFiles {
  if (!vaultRepo(vaultDir).isRoot)
    return { dirty: [], outgoing: [], incoming: [] };
  const dirty = git(vaultDir, "status", "--porcelain")
    .stdout.split("\n")
    .filter(Boolean)
    .map((l) => {
      const p = l.slice(3).trim();
      const i = p.indexOf(" -> "); // renames: keep the new path
      return i >= 0 ? p.slice(i + 4) : p;
    });
  const files = (range: string) => {
    const out = git(vaultDir, "log", "--name-only", "--format=", range);
    return out.status === 0
      ? [...new Set(out.stdout.split("\n").filter(Boolean))]
      : [];
  };
  const hasUpstream =
    git(vaultDir, "rev-parse", "--abbrev-ref", "@{upstream}").status === 0;
  return {
    dirty,
    outgoing: hasUpstream ? files("@{upstream}..HEAD") : [],
    incoming: hasUpstream ? files("HEAD..@{upstream}") : [],
  };
}

export function syncOp(
  vaultDir: string,
  apply: boolean,
  force = false,
): OpOutcome {
  const repo = vaultRepo(vaultDir);
  if (repo.inside && !repo.isRoot) {
    return {
      status: 2,
      message: `the vault is inside a larger git repo (${repo.root}) — a skill-loom vault must be its own repo; run "git init" in the vault first`,
      actions: [],
    };
  }
  const st = syncStatus(vaultDir, true);
  if (!st.versioned) {
    return {
      status: 2,
      message:
        'vault is not a git repository — run "git init" in the vault first',
      actions: [],
    };
  }
  // Run the vault's own rules before writing a commit. Save & sync commits with
  // --no-verify (to dodge a slow/hostile pre-commit hook), which would otherwise
  // also skip a doctor gate wired as that hook — so the tool enforces it here,
  // hook-independent. `force` is the explicit "commit anyway" escape hatch.
  if (st.dirty > 0 && !force) {
    const rep = collectDoctor(vaultDir);
    if (rep.count > 0) {
      return {
        status: 1,
        message: `${rep.count} rule problem(s) block this save — fix them, or commit anyway`,
        actions: rep.blocking,
        gate: rep.blocking,
      };
    }
  }
  if (!st.remote) {
    // No remote is not an error: version locally so the vault still gets a
    // checkpoint. Syncing to other machines waits until a remote is added.
    if (st.dirty === 0)
      return {
        status: 0,
        message: "nothing to save — the vault is up to date",
        actions: [],
      };
    const localActions = [`commit ${st.dirty} changed file(s) locally`];
    if (!apply)
      return {
        status: 0,
        message: "dry-run — nothing changed",
        actions: localActions,
      };
    git(vaultDir, "add", "-A");
    const c = git(
      vaultDir,
      "commit",
      "-m",
      `loom: save from ${hostname()}`,
      "--no-verify",
    );
    if (c.status !== 0)
      return {
        status: 1,
        message: `commit failed: ${(c.stderr || c.stdout).trim()}`,
        actions: localActions,
      };
    return {
      status: 0,
      message: `saved ${st.dirty} file(s) locally — add a remote to sync to your other machines`,
      actions: localActions,
    };
  }
  const actions: string[] = [];
  if (st.dirty > 0)
    actions.push(
      `commit ${st.dirty} changed file(s) as "loom: sync from ${hostname()}"`,
    );
  if (st.behind > 0)
    actions.push(`pull ${st.behind} commit(s) from origin (rebase)`);
  if (st.ahead > 0 || st.dirty > 0) actions.push("push to origin");
  if (actions.length === 0)
    return { status: 0, message: "already in sync", actions };
  if (!apply)
    return { status: 0, message: "dry-run — nothing changed", actions };
  if (st.dirty > 0) {
    git(vaultDir, "add", "-A");
    const c = git(
      vaultDir,
      "commit",
      "-m",
      `loom: sync from ${hostname()}`,
      "--no-verify",
    );
    if (c.status !== 0) {
      return {
        status: 1,
        message: `commit failed: ${(c.stderr || c.stdout).trim()}`,
        actions,
      };
    }
  }
  if (st.behind > 0) {
    const pull = git(vaultDir, "pull", "--rebase", "--no-edit", "origin");
    if (pull.status !== 0) {
      return {
        status: 1,
        message:
          'rebase stopped on a conflict — resolve it in the vault, run "git rebase --continue", then sync again',
        actions,
      };
    }
  }
  const push = git(vaultDir, "push", "-u", "origin", "HEAD");
  if (push.status !== 0) {
    return {
      status: 1,
      message: `push failed: ${(push.stderr || push.stdout).trim()}`,
      actions,
    };
  }
  return { status: 0, message: "synced", actions };
}

export function setRemote(
  vaultDir: string,
  url: string | undefined,
  apply: boolean,
): OpOutcome {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    return { status: 2, message: "a remote URL is required", actions: [] };
  }
  const inside = git(vaultDir, "rev-parse", "--is-inside-work-tree");
  if (inside.status !== 0) {
    return { status: 2, message: "vault is not a git repository", actions: [] };
  }
  const has = git(vaultDir, "remote", "get-url", "origin").status === 0;
  const actions = [`${has ? "set" : "add"} origin -> ${trimmed}`];
  if (!apply)
    return { status: 0, message: "dry-run — nothing changed", actions };
  const r = has
    ? git(vaultDir, "remote", "set-url", "origin", trimmed)
    : git(vaultDir, "remote", "add", "origin", trimmed);
  if (r.status !== 0) {
    return { status: 1, message: (r.stderr || r.stdout).trim(), actions };
  }
  return { status: 0, message: `origin set to ${trimmed}`, actions };
}
