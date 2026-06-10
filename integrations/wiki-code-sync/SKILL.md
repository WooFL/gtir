---
name: wiki-code-sync
description: >
  Keep wiki notes in sync with the code they document. Use after finishing a code change in a session
  where a gtir notes+code index is configured: detect notes whose cited code drifted, reconcile them,
  re-baseline. Trigger phrases: "sync the wiki", "did my change break any notes", or automatically at a
  natural stopping point after editing code.
---

# wiki-code-sync

When you have finished a code change (a natural breakpoint — NOT after every edit), keep the wiki honest:

1. Call the `stale_check` MCP tool. It returns notes whose cited code drifted, each with the symbol,
   severity (signature/body/removed), and the BEFORE/NOW.
2. For each stale note: open it, update ONLY what the code change invalidated, preserving the note's voice
   and structure.
   - **signature** → re-check parameter/return/arity claims.
   - **removed** → note the removal or point to the replacement symbol.
   - **body** → re-verify behavior claims still hold.
3. After fixing a note, call `stale_ack { note }` so the same drift stops flagging.
4. If a note intentionally describes a FUTURE/desired state that is ahead of the code, do not edit it —
   run `gtir stale mute "<note>#<symbol>"` (CLI) to exclude that link instead.

Do not fire per-edit. Once per logical change is right. The commit-time brief queue is the safety net for
anything you miss.
