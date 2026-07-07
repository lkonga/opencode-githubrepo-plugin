# Future: optional `gh` CLI

Tracked: https://github.com/lkonga/opencode-githubrepo-plugin/issues/12

## Today

- OpenCode Copilot device flow: `read:user` (no `repo`).
- Embeddings + private repos need a token with **repo** visibility → plugin uses `gh auth token` (and scope-404 retry).

## Desired (upstream)

- `anomalyco/opencode` Copilot login requests `repo` (or equivalent) so `auth.json` alone can search private repos.
- Plugin could then use `gh` only when Copilot OAuth is missing.

## Plugin follow-ups (after upstream)

- Extend scope-404 retry to index/shadow/fork APIs (today mainly on search).
- Detect sufficient OAuth scopes and skip `gh` when safe.