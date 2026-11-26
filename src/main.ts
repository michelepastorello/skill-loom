import { UsageError } from "./errors.js";
import { runInit } from "./commands/init.js";
import { runAdd } from "./commands/add.js";
import { runLink } from "./commands/link.js";
import { runStatus } from "./commands/status.js";
import { runDoctor } from "./commands/doctor.js";
import { runSchema } from "./commands/schema.js";
import { runArchive } from "./commands/archive.js";
import { runMigrate } from "./commands/migrate.js";
import { runUi } from "./commands/ui.js";
import { runSync } from "./commands/sync.js";
import { runLossAudit } from "./commands/loss-audit.js";

const USAGE = `skill-loom — one canonical vault of agent skills, symlinked into every runtime

usage:
  skill-loom init
  skill-loom add <name> [--<axis> <value>…] [--status <s>] [--description <text>]
  skill-loom link [--apply]
  skill-loom status
  skill-loom doctor
  skill-loom schema
  skill-loom archive <name> [--apply]
  skill-loom migrate <old> <new> [--apply]
  skill-loom ui [--port N] [--host ADDR] [--allow-remote-writes] [--no-open] [--brand-dir DIR]
  skill-loom sync [--apply] [--force]
  skill-loom loss-audit [--base REV] [--min-word-retention 0.65] [--map old.md=new.md] [--map-term old=new] [path ...]
  skill-loom loss-audit accept <file> --term <term> --reason "<why>" [--base REV]

link, archive, migrate and sync are dry-run by default: nothing changes without --apply.
Exit codes: 0 ok · 1 problems found · 2 usage/config error.`;

export function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

export function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const next = args[i + 1];
  // A following flag (or nothing) means no value was supplied; consume only the
  // flag itself so the next flag isn't swallowed as this one's value (which
  // would land a literal "--status" in a skill's frontmatter).
  if (next === undefined || next.startsWith("--")) {
    args.splice(i, 1);
    return undefined;
  }
  args.splice(i, 2);
  return next;
}

/** Whatever `--key value` pairs survive after the known flags were consumed:
 *  taxonomy axis values (--domain, --area, …). addOp rejects keys the vault
 *  does not declare, so a typo fails loudly instead of doing nothing. */
export function collectAxisFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length;) {
    const a = args[i];
    if (!a.startsWith("--")) {
      i++;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args.splice(i, 1);
      continue;
    }
    out[a.slice(2)] = next;
    args.splice(i, 2);
  }
  return out;
}

export function main(argv: string[], cwd: string): number {
  const args = [...argv];
  const cmd = args.shift();
  try {
    switch (cmd) {
      case undefined:
        console.error(USAGE);
        return 2;
      case "help":
      case "--help":
        console.log(USAGE);
        return 0;
      case "init":
        return runInit(cwd);
      case "add": {
        const opts = {
          description: opt(args, "--description"),
          status: opt(args, "--status"),
          taxonomy: collectAxisFlags(args),
        };
        return runAdd(cwd, args.shift(), opts);
      }
      case "link":
        return runLink(cwd, flag(args, "--apply"));
      case "status":
        return runStatus(cwd);
      case "doctor":
        return runDoctor(cwd);
      case "schema":
        // Read-only, so a stray arg (e.g. a typo'd --apply) would otherwise
        // be silently ignored — accepting it exits 0 having done nothing,
        // implying the flag had an effect it didn't.
        if (args.length > 0) {
          console.error(`schema takes no arguments (got "${args[0]}")`);
          return 2;
        }
        return runSchema(cwd);
      case "archive": {
        const apply = flag(args, "--apply");
        return runArchive(cwd, args.shift(), apply);
      }
      case "migrate": {
        const apply = flag(args, "--apply");
        return runMigrate(cwd, args.shift(), args.shift(), apply);
      }
      case "ui": {
        const port = opt(args, "--port");
        const portNum = port === undefined ? undefined : Number(port);
        if (portNum !== undefined && !Number.isInteger(portNum)) {
          console.error(`invalid --port "${port}"`);
          return 2;
        }
        const host = opt(args, "--host");
        const noOpen = flag(args, "--no-open");
        const allowRemoteWrites = flag(args, "--allow-remote-writes");
        const brandDir = opt(args, "--brand-dir");
        return runUi(cwd, {
          port: portNum,
          host,
          open: !noOpen,
          allowRemoteWrites,
          brandDir,
        });
      }
      case "sync": {
        const apply = flag(args, "--apply");
        return runSync(cwd, apply, flag(args, "--force"));
      }
      case "loss-audit":
        return runLossAudit(cwd, args);
      default:
        console.error(`unknown command "${cmd}"\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
}
