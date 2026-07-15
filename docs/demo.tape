# skill-loom — README demo (render with: vhs docs/demo.tape)
# Requires: vhs (brew install vhs). Produces docs/demo.gif.
# npx fetches the PUBLISHED skill-loom, so render this AFTER `npm publish` of
# the release (or `npm link` the local build first) — otherwise npx pulls an
# older version and the --domain/--status flags won't behave as shown.
Output docs/demo.gif

Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 24
Set Theme {"name": "skill-loom", "background": "#14191e", "foreground": "#dfe6eb", "cursor": "#5ecad6", "selection": "#242b32", "black": "#1b2127", "red": "#e66e68", "green": "#4cbd88", "yellow": "#e2a447", "blue": "#67a3e0", "magenta": "#a98ed9", "cyan": "#5ecad6", "white": "#dfe6eb", "brightBlack": "#313940", "brightRed": "#fb817a", "brightGreen": "#68d7a1", "brightYellow": "#f9ba5f", "brightBlue": "#83bdf5", "brightMagenta": "#c1a9ee", "brightCyan": "#82e0e5", "brightWhite": "#eff6fb"}
Set TypingSpeed 55ms

# Sandbox (NOT recorded): a throwaway HOME with only .claude and .codex, so
# init detects exactly those two runtimes and the links land in the sandbox —
# never touching your real runtime dirs, and keeping the status table narrow.
Hide
Type "export HOME=/tmp/loom-home && rm -rf /tmp/loom /tmp/loom-home && mkdir -p /tmp/loom-home/.claude /tmp/loom-home/.codex /tmp/loom && cd /tmp/loom" Enter
Type "npx skill-loom init >/dev/null 2>&1" Enter
Type "export PS1='$ '" Enter
Type "clear" Enter
Show

Sleep 500ms
Type "npx skill-loom add code-review --domain engineering --status active" Sleep 300ms Enter
Sleep 1.4s
Type "npx skill-loom status" Sleep 300ms Enter
Sleep 2s
Type "# dry-run: shows the plan, changes nothing" Sleep 200ms Enter
Type "npx skill-loom link" Sleep 300ms Enter
Sleep 2s
Type "npx skill-loom link --apply" Sleep 300ms Enter
Sleep 1.8s
Type "npx skill-loom status" Sleep 300ms Enter
Sleep 2.5s
