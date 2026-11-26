#!/usr/bin/env bash
# Deploy skill-loom to the VPS checkout (~/.openclaw/apps/skill-loom).
# The VPS `skill-loom` binary is an npm link to that checkout's dist/, so a deploy is:
# fast-forward to origin/main, npm ci if the lockfile changed, build, restart the UI.
# Fast-forward only: stops instead of discarding work committed or edited on the VPS.
# Publishing to npm is a separate, manual release step.
set -euo pipefail
HOST="${DEPLOY_HOST:-openclaw}"
TARGET="${DEPLOY_PATH:-.openclaw/apps/skill-loom}"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
export PATH="/home/linuxbrew/.linuxbrew/bin:\$PATH"
cd "$TARGET"
if [ -n "\$(git status --porcelain --untracked-files=no)" ]; then echo "STOP: uncommitted changes on the VPS" >&2; git status --short >&2; exit 1; fi
git checkout --quiet main
git fetch --quiet origin
if [ -n "\$(git rev-list origin/main..main)" ]; then echo "STOP: VPS has commits not on GitHub (push them first)" >&2; exit 1; fi
OLD=\$(git rev-parse HEAD)
git merge --quiet --ff-only origin/main
NEW=\$(git rev-parse HEAD)
if [ "\$OLD" = "\$NEW" ]; then echo "already up to date at \${NEW:0:7}"; exit 0; fi
if git diff --name-only "\$OLD" "\$NEW" | grep -qE '^package(-lock)?\.json$'; then npm ci --no-audit --no-fund --silent; fi
npm run --silent build
systemctl --user restart skill-loom-ui.service
for i in \$(seq 1 15); do curl -fs -o /dev/null "http://\$(tailscale ip -4 | head -1):18794/" && break; sleep 1; done
curl -fsS -o /dev/null "http://\$(tailscale ip -4 | head -1):18794/" || { echo "STOP: health check failed" >&2; exit 1; }
git log -1 --format='deployed %h %s'
REMOTE
