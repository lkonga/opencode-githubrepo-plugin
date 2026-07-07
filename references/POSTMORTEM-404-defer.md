# githubrepo 404 incident — deferred deep dive

**Status:** Tool working (`microsoft/vscode-copilot-chat` verified). Defer root-cause write-up.

## GitHub issue

https://github.com/lkonga/opencode-githubrepo-plugin/issues/8 — follow-up PM, surgical refactor, migration cleanup (no creds in issue).

## One-line fix (for later analysis)

Plugin **stopped calling** `POST /embeddings/code/search` when `GET …/embeddings_index` returned **404** (v1.0.8 restore regression). **`d0d5dcb`** treats index 404 as proceed-to-search again. Separate issue: some repos (`facebook/react`) 404 on **search** itself (Copilot entitlement).

## Commits on `main` (plugin)

- `a1c3fa6` — token-sync / shared / `gh` / auth.json chain; entitlement error text
- `d0d5dcb` — embeddings_index 404 → ready (search runs)

## Cleanup debt (no credentials in notes)

- `opencode-patches`: orphan `githubrepo.source.*`, stale `.vscode/tasks.json`, diverged safety test
- Plugin: tag v1.0.8, optional branch prune, tighter/surgical index gate vs skip-probe

## Do not document here

Auth file paths, tokens, or live `auth.json` contents.