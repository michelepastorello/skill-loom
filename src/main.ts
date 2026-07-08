import { UsageError } from "./errors.js";
import { runInit } from "./commands/init.js";
import { runAdd } from "./commands/add.js";
import { runLink } from "./commands/link.js";
import { runStatus } from "./commands/status.js";
import { runDoctor } from "./commands/doctor.js";
import { runArchive } from "./commands/archive.js";
import { runMigrate } from "./commands/migrate.js";
import { runUi } from "./commands/ui.js";
import { runSync } from "./commands/sync.js";

const USAGE = `skill-loom — one canonical vault of agent skills, symlinked into every runtime

usage:
  skill-loom init
  skill-loom add <name> [--category <dir>]
  skill-loom link [--apply]
  skill-loom status
  skill-loom doctor
  skill-loom archive <name> [--reason <text>] [--apply]
  skill-loom migrate <old> <new> [--apply]
  skill-loom ui [--port N] [--host ADDR] [--no-open]
  skill-loom sync [--apply]

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
  const removed = args.splice(i, 2);
  return removed[1];
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
        const category = opt(args, "--category");
        return runAdd(cwd, args.shift(), category);
      }
      case "link":
        return runLink(cwd, flag(args, "--apply"));
      case "status":
        return runStatus(cwd);
      case "doctor":
        return runDoctor(cwd);
      case "archive": {
        const apply = flag(args, "--apply");
        const reason = opt(args, "--reason");
        return runArchive(cwd, args.shift(), reason, apply);
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
        return runUi(cwd, {
          port: portNum,
          host,
          open: !noOpen,
        });
      }
      case "sync":
        return runSync(cwd, flag(args, "--apply"));
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
