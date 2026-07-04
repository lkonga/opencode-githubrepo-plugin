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

## Origin

Ported from the `patch-githubrepo.ts` fork patch in [opencode-patches](https://github.com/lkonga/opencode-patches).
The original implementation was injected directly into the opencode source tree; this plugin version
uses the official OpenCode plugin API and requires no source modifications.
