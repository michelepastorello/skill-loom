import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../config.js";
import { createUiServer } from "../server.js";
import { dim, red, yellow } from "../output.js";

export interface UiOptions {
  port?: number;
  host?: string;
  open: boolean;
  allowRemoteWrites?: boolean;
}

function isLocalHost(host: string): boolean {
  // localhost, IPv6 loopback, or anything in the 127.0.0.0/8 loopback block.
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function runUi(vaultDir: string, opts: UiOptions): number {
  loadConfig(vaultDir); // valida che siamo in un vault (UsageError -> exit 2 in main)
  const host = opts.host ?? "127.0.0.1";
  // The dashboard exposes write endpoints (mutate the vault, run git) with no
  // auth. Refuse to bind them to a non-local address unless the operator opts
  // in explicitly, so an accidental --host never silently exposes writes.
  if (!isLocalHost(host) && !opts.allowRemoteWrites) {
    console.error(
      red(
        `refusing to expose write actions on ${host}: pass --allow-remote-writes to bind a non-local host (no auth), or drop --host to stay on 127.0.0.1`,
      ),
    );
    return 2;
  }
  const server = createUiServer(vaultDir);
  // Without this, a bind failure (e.g. the port is taken) emits an unhandled
  // 'error' and crashes with a stack trace instead of a clean message.
  server.on("error", (err: NodeJS.ErrnoException) => {
    const why =
      err.code === "EADDRINUSE"
        ? `port ${opts.port} on ${host} is already in use`
        : err.message;
    console.error(red(`skill-loom ui: ${why}`));
    process.exitCode = 1;
  });
  server.listen(opts.port ?? 0, host, () => {
    const addr = server.address() as AddressInfo;
    const url = `http://${host}:${addr.port}/`;
    console.log(`skill-loom ui — ${url}`);
    console.log(dim("Ctrl+C to stop"));
    if (!isLocalHost(host)) {
      console.log(
        yellow(
          `warning: the dashboard exposes write actions on ${host} with no authentication`,
        ),
      );
    }
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      // Opening a browser is best-effort: a missing opener (headless VPS)
      // must not crash the server with an unhandled spawn 'error'.
      const child = spawn(opener, [url], { stdio: "ignore", detached: true });
      child.on("error", () =>
        console.log(dim(`(could not launch ${opener}; open ${url} manually)`)),
      );
      child.unref();
    }
  });
  return 0;
}
