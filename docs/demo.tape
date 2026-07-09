# skill-loom — README demo (render with: vhs docs/demo.tape)
# Requires: vhs (brew install vhs). Produces docs/demo.gif
Output docs/demo.gif

Set FontSize 20
Set Width 1200
Set Height 700
Set Padding 24
Set Theme {"name": "skill-loom", "background": "#14191e", "foreground": "#dfe6eb", "cursor": "#5ecad6", "selection": "#242b32", "black": "#1b2127", "red": "#e66e68", "green": "#4cbd88", "yellow": "#e2a447", "blue": "#67a3e0", "magenta": "#a98ed9", "cyan": "#5ecad6", "white": "#dfe6eb", "brightBlack": "#313940", "brightRed": "#fb817a", "brightGreen": "#68d7a1", "brightYellow": "#f9ba5f", "brightBlue": "#83bdf5", "brightMagenta": "#c1a9ee", "brightCyan": "#82e0e5", "brightWhite": "#eff6fb"}
Set TypingSpeed 55ms

# Sandbox (NOT recorded): short vault path + LOCAL throwaway consumers,
# so the demo never touches your real ~/.claude or ~/.agents dirs.
Hide
Type "rm -rf /tmp/loom && mkdir -p /tmp/loom/rt/claude /tmp/loom/rt/codex && cd /tmp/loom" Enter
Type "npx skill-loom init >/dev/null 2>&1" Enter
Type "sed -i '' 's#~/.claude/skills#/tmp/loom/rt/claude#; s#~/.agents/skills#/tmp/loom/rt/codex#' loom.json" Enter
Type "export PS1='$ '" Enter
Type "clear" Enter
Show

Sleep 500ms
Type "npx skill-loom add code-review --category engineering" Sleep 300ms Enter
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
