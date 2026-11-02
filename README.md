# opencode-githubrepo

**v1.0.11** — Semantic code search across GitHub repositories using GitHub’s Copilot embeddings API (`api.github.com`). One package, three hosts: OpenCode plugin (`index.ts`) + OMP extension (`omp.ts`) + OMO extension (`omo.ts`). No fork patches, no CAPI proxy, no `opencode-patches` dependency.

## Quick start (anyone)

1. Install the plugin (see [Installation](#installation)).
2. Authenticate:
   - **OpenCode (required for Copilot API):** `opencode auth login` → **github-copilot** → `~/.local/share/opencode/auth.json`.
   - **GitHub CLI (required for private repos):** `gh auth login` + `repo` scope (`gh auth refresh -s repo`). Without `gh`, many **public** repos work; **private** search, indexing, and branch/shadow flows typically need `gh auth token`.
3. Restart OpenCode after installing or changing auth.

**Zero config:** no `OPENCODE_CONFIG_DIR`, `TOKEN_SYNC_*`, or fork wrapper required. Auth defaults to `~/.local/share/opencode/auth.json` (same as upstream OpenCode docs); optional `githubrepo-config.json` only for tuning timeouts.

**Default behavior:** tries Copilot OAuth first, then **`gh auth token`** once if GitHub returns a scope/entitlement 404. For mostly private repos, set `GITHUBREPO_PREFER_GH=1` to try `gh` first.

## What it does

- Searches any GitHub repository you have access to using semantic/embedding-based search
- Returns ranked code snippets with file paths, line numbers, and similarity scores
- Automatically triggers indexing for repositories that haven't been indexed yet
- Supports branch search via persistent shadow repos

## Requirements

- A **GitHub Copilot** subscription (embeddings search is a Copilot API).
- **Auth:** Copilot OAuth in OpenCode **plus** `gh` when you need **private** repos (see [Quick start](#quick-start-anyone)). Future: [issue #12](https://github.com/lkonga/opencode-githubrepo-plugin/issues/12) tracks reducing `gh` dependency via upstream `repo` scope on Copilot login.

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

### MCP (stdio)

Install the package and Bun, then configure your MCP host to launch the installed TypeScript entry point (replace the path with your installation location):

```json
{
  "mcpServers": {
    "repotool": {
      "command": "bun",
      "args": ["/path/to/node_modules/@lkonga/opencode-githubrepo/mcp-server.ts"]
    }
  }
}
```

The server uses the authentication described above and exposes `repotool` and `repotool_global` (parameters: `discovery`, `query`, optional `path`). Path filters work; language filters are unsupported and rejected. Branch searches create shadow repositories and are rejected when `GITHUBREPO_BRANCH_SEARCH=false`.

### OMP (oh-my-pi)

Same package, second host (`omp.ts` reuses the `index.ts` pipeline via OMP `ExtensionAPI`; `index.ts`/`tui.ts` untouched, enabled via `omp.extensions` in `package.json`).

```sh
omp plugin link /path/to/opencode-githubrepo-plugin
omp plugin list  # must show @lkonga/opencode-githubrepo
```

- Tool `githubrepo` with the same `repo`/`query`/`branch`/`path`/`lang` params.
- Command `/githubrepo` shows settings + token presence (never token material). Status view only, no interactive editing yet.
- Auth is identical: OpenCode `auth.json` Copilot OAuth plus `gh auth token` (`repo` scope for private repos); `GITHUBREPO_PREFER_GH=1` for private-heavy use.

### OMO (omo / senpi)

Same package, third host (`omo.ts` reuses the `index.ts` pipeline via the senpi `ExtensionAPI`; `index.ts`/`tui.ts`/`omp.ts` untouched, enabled via `pi.extensions` in `package.json`).

```sh
omo install /path/to/opencode-githubrepo-plugin
omo list  # must show the installed package
```

- Tool `githubrepo` with the same `repo`/`query`/`branch`/`path`/`lang` params.
- Command `/githubrepo` shows settings + token presence (never token material). Status view only, no interactive editing yet.
- Auth is identical: OpenCode `auth.json` Copilot OAuth plus `gh auth token` (`repo` scope for private repos); `GITHUBREPO_PREFER_GH=1` for private-heavy use.
- Host differences from `omp.ts`: senpi `ToolDefinition.parameters` is a TypeBox schema (not zod), and senpi `ExtensionAPI` has no `pi.zod`/`pi.logger`.

### PI (pi-coding-agent)

Same package, fourth host (`pi.ts` reuses the `index.ts` pipeline via the pi-coding-agent `ExtensionAPI`; `index.ts`/`tui.ts`/`omp.ts`/`omo.ts` untouched, enabled via `pi.extensions` in `package.json`).

```sh
# Install by linking the repo into ~/.pi/agent/extensions/
ln -s /path/to/opencode-githubrepo-plugin ~/.pi/agent/extensions/opencode-githubrepo
```

- Tool `githubrepo` with the same `repo`/`query`/`branch`/`path`/`lang` params.
- Command `/githubrepo` shows settings + token presence (never token material). Status view only, no interactive editing yet.
- Auth is identical: OpenCode `auth.json` Copilot OAuth plus `gh auth token` (`repo` scope for private repos); `GITHUBREPO_PREFER_GH=1` for private-heavy use.

## Usage

Ask the AI to search a GitHub repo:

> "Search the facebook/react repo for reconciler fiber scheduling"
> "Find how BusEvent is defined in the opencode repo"

### CLI

For bounded discovery and search, run `bun cli.ts --global "topic:testing language:TypeScript" "test runner"` (optionally add `--path src/`). The first query uses GitHub repository metadata search, not code search; the second is the semantic code query. `repotool_global` provides the same behavior over MCP. Discovery examines at most five candidates from one GitHub search page and searches their default branches sequentially using the existing Copilot index workflow, which may trigger indexing. It can include private repositories visible to the token. Results are not exhaustive or globally ranked; failures, incomplete discovery, and timeouts are reported as partial results. Discovery errors, including rate limits, fail the request; a possible rate limit during search stops further candidates. The overall search timeout also bounds indexing and all candidates. Metadata search requires a token with appropriate GitHub access as well as Copilot embeddings access.

With Bun and the package dependencies installed, run `bun cli.ts --help` from the package directory. For example:

```sh
bun cli.ts --path src/ facebook/react "fiber scheduling"
```

The CLI searches the specified repository's default branch, not all of GitHub. It uses the same authentication and indexing as the plugin. Results go to stdout; errors go to stderr and return a nonzero exit status. `GITHUBREPO_SEARCH_TIMEOUT` sets the overall search timeout in milliseconds. Branch URLs are not supported by the CLI. The published package includes `cli.ts` and `skills/githubrepo/SKILL.md`; invoke the CLI with Bun from the installed package directory, and copy the skill directory into your agent's skills directory if desired.

## Tool parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `repo` | string | `owner/repo` or full GitHub URL (supports `/tree/branch`) |
| `query` | string | Semantic search query |
| `branch` | string? | Non-default branch to search |
| `path` | string[]? | Filter by file paths |
| `lang` | string[]? | Unsupported; non-empty values are rejected |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUBREPO_BRANCH_SEARCH` | `true` | Enable branch search via shadow repos |
| `GITHUBREPO_BRANCH_TIMEOUT` | `180000` | ms to wait for branch indexing |
| `GITHUBREPO_SHADOW_PREFIX` | `tmp-ghrtool` | Prefix for shadow repo names |
| `GITHUBREPO_ALLOW_PRIVATE_SHADOW` | unset | Set exactly `true` to allow copying private or unknown-visibility sources into shadows |

Private source branch search creates a separate, durable private repository containing the branch history. It persists after access to or deletion of the source, can retain sensitive history, and has its own access and retention settings; indexing also sends the copy to GitHub's indexing service. Enable this only with authorization, and delete the shadow and manage its retention separately when no longer needed.

| Variable | Default | Description |
|----------|---------|-------------|
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
