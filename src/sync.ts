import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import type { OpOutcome } from "./ops.js";

export interface SyncStatus {
  versioned: boolean;
  remote: string | null;
  dirty: number;
  ahead: number;
  behind: number;
}

function git(vaultDir: string, ...args: string[]) {
  return spawnSync("git", ["-C", vaultDir, ...args], { encoding: "utf8" });
}

export function syncStatus(vaultDir: string, fetchFirst = false): SyncStatus {
  const inside = git(vaultDir, "rev-parse", "--is-inside-work-tree");
  if (inside.error || inside.status !== 0) {
    return { versioned: false, remote: null, dirty: 0, ahead: 0, behind: 0 };
  }
  const remoteOut = git(vaultDir, "remote", "get-url", "origin");
  const remote = remoteOut.status === 0 ? remoteOut.stdout.trim() : null;
  const dirty = git(vaultDir, "status", "--porcelain")
    .stdout.split("\n")
    .filter(Boolean).length;
  let ahead = 0;
  let behind = 0;
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
  }
  return { versioned: true, remote, dirty, ahead, behind };
}

export function syncOp(vaultDir: string, apply: boolean): OpOutcome {
  const st = syncStatus(vaultDir, true);
  if (!st.versioned) {
    return {
      status: 2,
      message:
        'vault is not a git repository — run "git init" in the vault first',
      actions: [],
    };
  }
  if (!st.remote) {
    return {
      status: 2,
      message:
        'no git remote configured — run "git remote add origin <url>" in the vault first',
      actions: [],
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
