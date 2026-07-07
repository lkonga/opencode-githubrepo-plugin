# opencode-githubrepo

**v1.0.10** — OpenCode plugin for semantic code search across GitHub repositories using GitHub’s Copilot embeddings API (`api.github.com`). No fork patches, no CAPI proxy, no `opencode-patches` dependency.

## Quick start (anyone)

1. Install the plugin (see [Installation](#installation)).
2. Authenticate with **at least one** of:
   - **OpenCode (recommended for Copilot subscribers):** `oc auth login` → **github-copilot** (writes `auth.json`).
   - **GitHub CLI (needed for many private repos):** `gh auth login` and ensure `repo` scope (`gh auth refresh -s repo`). The plugin runs `gh auth token` automatically.
3. Restart OpenCode after installing or changing auth.

**Default behavior:** tries Copilot OAuth first, then **`gh auth token`** once if GitHub returns a scope/entitlement 404. For mostly private repos, set `GITHUBREPO_PREFER_GH=1` to try `gh` first.

## What it does

- Searches any GitHub repository you have access to using semantic/embedding-based search
- Returns ranked code snippets with file paths, line numbers, and similarity scores
- Automatically triggers indexing for repositories that haven't been indexed yet
- Supports branch search via persistent shadow repos

## Requirements

- A **GitHub Copilot** subscription (embeddings search is a Copilot API).
- **Auth:** Copilot OAuth in OpenCode **and/or** `gh` CLI logged in (see [Quick start](#quick-start-anyone)).

### Where OpenCode stores Copilot OAuth (`auth.json`, first readable path wins)

| Priority | Path |
|----------|------|
| 1 | `GITHUBREPO_AUTH_JSON` env |
| 2 | `authJson` in `$OPENCODE_CONFIG_DIR/githubrepo-config.json` |
| 3 | `$XDG_DATA_HOME/opencode/auth.json` (if your distro sets `XDG_DATA_HOME`) |
| 4 | `~/.local/share/opencode/auth.json` (**vanilla / upstream OpenCode**) |

### Token modes (default = plugin-only)

| Mode | Primary | On scope 404, retry with |
|------|---------|---------------------------|
| **Default** | `auth.json` Copilot OAuth | `gh auth token` |
| `GITHUBREPO_PREFER_GH=1` | `gh auth token` | Copilot OAuth |

**Why two tokens?** Copilot OAuth has **Copilot entitlement** (many public/org repos) but often lacks **`repo` scope** for your private repos. `gh auth token` usually has **`repo`** but not entitlement. The plugin retries once with the other token automatically.

**Advanced (optional):** If both `TOKEN_SYNC_URL` and `TOKEN_SYNC_SECRET` are set, the plugin uses legacy shared-token files only and **does not** fall back to `auth.json` / `gh`. Most users should leave these unset.

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

Originally ported from a fork patch; **v1.0.9+** is a standalone OpenCode plugin (official plugin API only, no source patches).
