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

This writes a flat `demo/demo-vault/` (one folder per skill) with all 13 skills, a
3-commit git history (so the detail page's History panel is populated), a spread
of lifecycle states across the five chips (idea / draft / active / suspended /
deprecated), and three runtimes: `claude` and `codex` as symlink consumers, plus
an in-place `openclaw` that reads the vault straight from its own config (so the
detail page shows the in-place toggle). Active skills link into all three;
non-active ones stay unprojected. `code-review` is the one multi-file skill — it
carries the grouped file-panel demo (`SKILL.md` + `requirements.txt` at the root,
`references/checklist.md`, `scripts/run-review.py`).

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
