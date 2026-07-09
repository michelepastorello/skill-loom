# Demo vault

The vault behind the README screenshots — 13 generic skills (Engineering /
Research / Writing) so the dashboard can be shown without exposing any real,
private skills.

The generated vault (`demo/demo-vault/`) is **gitignored**. This folder keeps the
two scripts that reproduce it, so the screenshots stay regenerable on any clone.

## Regenerate the vault

```bash
node demo/scaffold-demo.mjs
```

This writes `demo/demo-vault/` with all 13 skills, a 3-commit git history (so the
detail page's History panel is populated), and links every skill into a `claude`
and `codex` runtime (so the "Active on" toggles read as on). `code-review` is the
one multi-file skill — it carries the grouped file-panel demo (`SKILL.md` +
`requirements.txt` at the root, `references/checklist.md`, `scripts/run-review.py`).

## Serve it

```bash
cd demo/demo-vault && skill-loom ui --port 7777
```

## Re-shoot the README images (2× / 2720×1760)

```bash
npm i -D playwright && npx playwright install chromium   # once
node demo/shoot.mjs http://127.0.0.1:7777/ docs/dashboard-library.png
node demo/shoot.mjs http://127.0.0.1:7777/ docs/dashboard-detail.png "code review"
```
