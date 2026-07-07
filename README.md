# opencode-githubrepo

OpenCode plugin for semantic code search across GitHub repositories using Copilot's embeddings index.

## What it does

- Searches any GitHub repository you have access to using semantic/embedding-based search
- Returns ranked code snippets with file paths, line numbers, and similarity scores
- Automatically triggers indexing for repositories that haven't been indexed yet
- Supports branch search via persistent shadow repos

## Requirements

- GitHub Copilot OAuth via OpenCode: run `oc auth login` and choose **github-copilot**.

**Auth file resolution (first hit wins):**

| Priority | Source | Typical use |
|----------|--------|-------------|
| 1 | `GITHUBREPO_AUTH_JSON` | Explicit path when the OpenCode process does not inherit your wrapper env |
| 2 | `authJson` in `$OPENCODE_CONFIG_DIR/githubrepo-config.json` | Same, checked into host env config |
| 3 | `$XDG_DATA_HOME/opencode/auth.json` | Fork wrapper sets `XDG_DATA_HOME` (e.g. `~/.local/share/opencode-fork`) |
| 4 | `~/.local/share/opencode/auth.json` | Upstream / vanilla OpenCode (distribution default) |

Fork users: if the wrapper exports `XDG_DATA_HOME`, step 3 is enough. If `githubrepo` still fails to authenticate, set step 1 or 2 to your fork auth file, e.g. `~/.local/share/opencode-fork/opencode/auth.json`.

## Token resolution for embeddings search

The plugin is **self-contained by default** — it does not depend on `opencode-patches` or a shared token-sync daemon. Token order for `POST /embeddings/code/search`:

| Mode | Primary token | Scope-404 retry | Covers |
|------|---------------|-----------------|--------|
| **Default** (plugin-only) | OpenCode `auth.json` Copilot OAuth | `gh auth token` | Public (entitlement-gated) → private (one retry) |
| `GITHUBREPO_PREFER_GH=1` | `gh auth token` | Copilot OAuth | Private-repo-heavy use (skips the wasted OAuth 404) |
| `TOKEN_SYNC_URL`+`TOKEN_SYNC_SECRET` (opt-in) | `token-sync-live.json` → `copilot-shared-token.json` | none | Legacy shared-token infra only; refuses other fallbacks |

Why two tokens? Copilot OAuth carries the **Copilot entitlement** (public repos gated behind it, e.g. `microsoft/vscode-copilot-chat`) but lacks classic `repo` scope for private repos. `gh auth token` (classic PAT) has `repo` scope (private repos) but no Copilot entitlement. The scope-404 retry bridges this automatically — see `isEmbeddingsScopeDenied` + `pickScopeFallback` in `index.ts` (unit-tested in `githubrepo.test.ts`).

## Installation

### npm (recommended)

```json
{
  "plugin": ["@lkonga/opencode-githubrepo"]
}
```

If you want the `/githubrepo` TUI command, also add to `tui.json`:

```json
{
  "plugin": ["@lkonga/opencode-githubrepo"]
}
```

### Local file path (npm not desired)

If you don't want to install with npm, use `file://` paths. Add to `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-githubrepo/index.ts"]
}
```

And to `tui.json` for the `/githubrepo` TUI command:

```json
{
  "plugin": ["file:///path/to/opencode-githubrepo/tui.ts"]
}
```

## Usage

Ask the AI to search a GitHub repo:

> "Search the facebook/react repo for reconciler fiber scheduling"
> "Find how BusEvent is defined in the opencode repo"

## Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repo` | string | `owner/repo` or full GitHub URL (supports `/tree/branch`) |
| `query` | string | Semantic search query |
| `branch` | string? | Non-default branch to search |
| `path` | string[]? | Filter by file paths |
| `lang` | string[]? | Filter by language |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUBREPO_BRANCH_SEARCH` | `true` | Enable branch search via shadow repos |
| `GITHUBREPO_BRANCH_TIMEOUT` | `180000` | ms to wait for branch indexing |
| `GITHUBREPO_SHADOW_PREFIX` | `tmp-ghrtool` | Prefix for shadow repo names |
| `GITHUBREPO_MAX_RESULTS` | `64` | Max results returned |
| `GITHUBREPO_POLL_DELAY_MS` | `1000` | Polling interval in ms |
| `GITHUBREPO_AUTH_JSON` | — | Explicit path to OpenCode `auth.json` (supports `~/…`) |
| `authJson` in `githubrepo-config.json` | — | Same as env; lives in `$OPENCODE_CONFIG_DIR` |
| `GITHUBREPO_OPENCODE_AUTH_FALLBACK` | enabled | Set `false` to skip OpenCode `auth.json` |
| `XDG_DATA_HOME` | `~/.local/share` | OpenCode data root (`opencode/auth.json`) |
| `GITHUBREPO_POLL_ATTEMPTS` | `10` | Max poll attempts for default branch |
| `GITHUBREPO_PREFER_GH` | `0` | `1` to prefer `gh auth token` as search primary (private-repo-heavy use) |
| `TOKEN_SYNC_URL` + `TOKEN_SYNC_SECRET` | — | Both set = opt-in legacy token-sync/shared-token path (refuses other fallbacks) |

## Troubleshooting

A failed search is usually one of three causes — distinguish them before chasing a token bug:

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `404 "repository not found"` with `protected_org_ids` in the raw text | **Token scope** — primary token lacks repo/embeddings scope. The plugin retries once with the other token automatically; if both fail, the repo is private to your account. | Ensure `gh auth token` has `repo` scope (`gh auth refresh -s repo`), or set `GITHUBREPO_PREFER_GH=1`. |
| `404`/`Cannot access repository` for a *public* repo you can open in a browser | **Bad `owner/repo`** — wrong case, trailing `.git`, or a renamed repo. The embeddings index is keyed on exact `owner/repo` (case-sensitive owner). | Use the exact `owner/repo` from the GitHub URL. |
| Index `not-indexed`/`building` that never becomes `ready`, or `0 results` on a huge repo | **Indexing limit** — Copilot embeddings index lags or excludes very large/renamed repos. Some repos (e.g. `facebook/react`) 404 on search itself (Copilot entitlement). | Wait and retry; for private forks, trigger indexing and poll. This is a GitHub-side limit, not a plugin bug. |
| `Not authenticated with GitHub Copilot` | **Harness token bug** — OpenCode `auth.json` not found / not a `github-copilot` oauth entry, and `gh` not logged in. | Run `oc auth login` (github-copilot) or `gh auth login`; see the auth-file resolution table above. |

Plugin/harness token bugs (rows 1 & 4) are *plugin-fixable*; bad `owner/repo` (row 2) and indexing limits (row 3) are *not* — they are GitHub-side. Issue #8 tracks the deferred deeper write-up.

## Origin

Ported from the `patch-githubrepo.ts` fork patch in [opencode-patches](https://github.com/lkonga/opencode-patches).
The original implementation was injected directly into the opencode source tree; this plugin version
uses the official OpenCode plugin API and requires no source modifications.
