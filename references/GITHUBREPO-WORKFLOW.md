# githubrepo — what you test vs what you rebuild

## Runtime (this is what you verified)

| Piece | Location | Restart needed? |
|-------|----------|-----------------|
| Tool + auth | `file:///…/opencode-githubrepo` in stable `opencode.jsonc` | **Yes** — restart `oc` after `git pull` on plugin |
| Fork binary | `~/.opencode/bin/opencode-real` | **No** — for githubrepo-only changes |

`oc --version` → `1.17.13-dev-patched-f77a41366d` is the **fork build id**, not the plugin. It **does not change** when you fix githubrepo unless you run a full `build-opencode` for other reasons.

## Patches repo cleanup (orphan `githubrepo.source.*`)

- **Not compiled** into your current binary (`oc --patches` / manifest has **no** githubrepo patch).
- Deleting orphans = repo hygiene only; **no rebuild required** to validate githubrepo.

## Smoke test (prod)

1. Restart `oc`.
2. Three `githubrepo` calls: `lkonga/opencode-patches`, `lkonga/llm-config-wiring`, `microsoft/vscode-copilot-chat`.

## Checkpoint

- Plugin: tag `githubrepo-known-good-20260707` or commit `a8c3243` (`export default { id, server: plugin }`).
- Rollback: `git checkout githubrepo-known-good-20260707` → restart `oc`.

## When you *do* rebuild the fork

Only for **other** patches (queue, steer, CAPI, etc.) or upstream bump — not for githubrepo plugin edits.