# opencode-githubrepo

OpenCode plugin for semantic code search across GitHub repositories using Copilot's embeddings index.

## What it does

- Searches any GitHub repository you have access to using semantic/embedding-based search
- Returns ranked code snippets with file paths, line numbers, and similarity scores
- Automatically triggers indexing for repositories that haven't been indexed yet
- Supports branch search via persistent shadow repos

## Installation

### npm

```json
{
  "plugin": ["opencode-githubrepo"]
}
```

### Local

```json
{
  "plugin": ["file:///path/to/opencode-githubrepo/index.ts"]
}
```

## Requirements

- GitHub Copilot authentication via `opencode auth` (github-copilot provider)
- Alternatively, a VS Code Copilot token at `~/.local/share/copilot-shared-token.json`

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
| `GITHUBREPO_POLL_ATTEMPTS` | `10` | Max poll attempts for default branch |

## Origin

Ported from the `patch-githubrepo.ts` fork patch in [opencode-patches](https://github.com/lkonga/opencode-patches).
The original implementation was injected directly into the opencode source tree; this plugin version
uses the official OpenCode plugin API and requires no source modifications.
