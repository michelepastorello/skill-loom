import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../config.js";
import { createUiServer } from "../server.js";
import { dim, yellow } from "../output.js";

export interface UiOptions {
  port?: number;
  host?: string;
  open: boolean;
}

export function runUi(vaultDir: string, opts: UiOptions): number {
  loadConfig(vaultDir); // valida che siamo in un vault (UsageError -> exit 2 in main)
  const host = opts.host ?? "127.0.0.1";
  const server = createUiServer(vaultDir);
  server.listen(opts.port ?? 0, host, () => {
    const addr = server.address() as AddressInfo;
    const url = `http://${host}:${addr.port}/`;
    console.log(`skill-loom ui — ${url}`);
    console.log(dim("Ctrl+C to stop"));
    if (host !== "127.0.0.1" && host !== "localhost") {
      console.log(
        yellow(`warning: the dashboard exposes write actions on ${host}`),
      );
    }
    if (opts.open) {
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
    }
  });
  return 0;
}
