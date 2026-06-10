# wiki-code-sync — install

Surfaces gtir's code→note drift detection inside a claude-obsidian vault.

## Prerequisites
- gtir on PATH; a **notes** index (the wiki vault) and a **code** index (the repo it documents) both built.
- The gtir MCP server serving BOTH indexes (so `stale_check`/`stale_ack` resolve). Confirm with `gtir_status`.

## One-time baseline
```
gtir stale baseline --repo <vault> --link-repo <codeRepo>
```
Writes `<vault>/.gtir/stale-baselines.json` (gitignore it). Everything starts "fresh" — no alarms until code changes.

## In-session surface (primary)
Copy `SKILL.md` to `<vault>/.claude/skills/wiki-code-sync/SKILL.md` (or your plugin's skills dir). The agent
runs `stale_check` at a breakpoint after editing code and reconciles notes inline.

## Commit-time surface (safety net)
Add to the code repo's post-commit hook (e.g. `tools/command-center/git-hooks/post-commit`):
```
gtir stale check --repo <vault> --link-repo <codeRepo> --emit-briefs <vault>/.command-center/queue
```
Drift briefs (`reason: code-drift`) land in the queue; drain them with `/vault-update`. Each brief's last
steps re-baseline (`gtir stale ack`) and delete the brief.

## Manual
```
gtir stale check --repo <vault> --link-repo <codeRepo>
```
