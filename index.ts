import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { readFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ─── Config from environment ─────────────────────────────────────────────────

const API = "https://api.github.com"
const MAX_RESULTS = Number(process.env.GITHUBREPO_MAX_RESULTS) || 64
const EMBEDDING_MODEL = process.env.GITHUBREPO_EMBEDDING_MODEL ?? "metis-1024-I16-Binary"
const MAX_QUERY_BYTES = Number(process.env.GITHUBREPO_MAX_QUERY_BYTES) || 7800
const POLL_ATTEMPTS = Number(process.env.GITHUBREPO_POLL_ATTEMPTS) || 10
const POLL_DELAY = Number(process.env.GITHUBREPO_POLL_DELAY_MS) || 1000
const API_VERSION = process.env.GITHUBREPO_API_VERSION ?? "2022-11-28"
const BRANCH_SEARCH = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"
const BRANCH_TIMEOUT = Number(process.env.GITHUBREPO_BRANCH_TIMEOUT) || 180000
const SEARCH_TIMEOUT = Number(process.env.GITHUBREPO_SEARCH_TIMEOUT) || 120000
const SHADOW_PREFIX = process.env.GITHUBREPO_SHADOW_PREFIX || "tmp-ghrtool"
const SHARED_TOKEN_PATH = join(homedir(), ".local", "share", "copilot-shared-token.json")
const CONFIG_FILE_NAME = "githubrepo-config.json"

function readSearchConfig(): Record<string, string> {
  const dir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
  try { return JSON.parse(readFileSync(join(dir, CONFIG_FILE_NAME), "utf8")) }
  catch { return {} }
}

function cfgSecondsToMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : fallbackMs
}

function envMsOrCfgSeconds(envName: string, cfgValue: string | undefined, fallbackMs: number): number {
  const envValue = process.env[envName]
  if (envValue !== undefined) {
    const parsed = Number(envValue)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
  }
  return cfgSecondsToMs(cfgValue, fallbackMs)
}

function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  return (err as any)?.name === "AbortError" || (err as any)?.name === "TimeoutError" || !!signal?.aborted
}

// ─── Description ─────────────────────────────────────────────────────────────

const DESCRIPTION = `\
- Semantic code search across GitHub repositories using Copilot's embeddings index
- Searches the full codebase of any GitHub repository you have access to (public and private)
- Returns relevant code snippets with file paths, line numbers, and similarity scores
- Automatically triggers indexing for repositories that haven't been indexed yet
- Use this when you need to find code in a remote GitHub repository without cloning it
- Requires GitHub Copilot authentication (github-copilot provider)

Usage notes:
  - The repo parameter accepts "owner/repo" format or full GitHub URLs (supports /tree/branch-name)
  - Returns up to 64 code snippets ranked by semantic relevance
  - Results include direct GitHub links to the matching code
  - If a repository is not yet indexed, the tool will trigger indexing and wait up to 10 seconds
  - Large repositories may take longer to index on first use

Branch search (non-default branches):
  - Omit branch when searching the repository default branch. Passing the default branch
    still triggers shadow-repo mode and is slower/error-prone.
  - The embeddings API only indexes the default branch. To search other branches, the tool
    creates persistent shadow repos under your account named tmp-ghrtool-{repo}-{branch}.
  - Set the branch parameter or include /tree/branch-name in the URL
  - Self-owned repos: creates a private shadow repo via GitHub import API
  - Other repos: forks under shadow name, sets target branch as default
  - Shadow repos are persistent — reused on subsequent searches (no re-creation overhead)
  - First search on a new branch is slower (~15-60s for indexing)
  - To clean up shadow repos: delete repos matching tmp-ghrtool-* from your account
  - Disable with GITHUBREPO_BRANCH_SEARCH=false

Filtering:
  - Use path parameter to filter by file paths: ["src/", "README.md"]
  - Use lang parameter to filter by language: ["TypeScript", "Python"]

Examples:
  - Basic: { "repo": "facebook/react", "query": "reconciler fiber scheduling" }
  - With URL: { "repo": "https://github.com/facebook/react", "query": "hooks implementation" }
  - Branch via URL: { "repo": "https://github.com/owner/repo/tree/feature-x", "query": "new api" }
  - Branch via param: { "repo": "owner/repo", "query": "search term", "branch": "develop" }
  - Search 3 branches: call 3 times with branch "main", "staging", "feature-x"
  - With filters: { "repo": "owner/repo", "query": "error handling", "path": ["src/"], "lang": ["TypeScript"] }

Environment variables:
  - GITHUBREPO_OPENCODE_AUTH_FALLBACK: "false" disables fallback to ~/.local/share/opencode/auth.json
  - GITHUBREPO_BRANCH_SEARCH: "true" (default) or "false" to disable branch search
  - GITHUBREPO_BRANCH_TIMEOUT: ms to wait for branch index (default: 180000)
  - GITHUBREPO_SHADOW_PREFIX: prefix for shadow repos (default: "tmp-ghrtool")
  - GITHUBREPO_MAX_RESULTS: max results (default: 64)
  - GITHUBREPO_POLL_DELAY_MS: polling interval ms (default: 1000)
  - GITHUBREPO_POLL_ATTEMPTS: max poll attempts for default branch (default: 10)`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(timer)
      reject(signal.reason)
    })
  })
}

function parseRepo(input: string): { owner: string; repo: string; branch?: string } | undefined {
  const simple = input.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (simple) return { owner: simple[1], repo: simple[2] }
  try {
    const url = new URL(input)
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean)
      if (parts.length >= 2) {
        const result: { owner: string; repo: string; branch?: string } = { owner: parts[0], repo: parts[1] }
        if (parts.length >= 4 && parts[2] === "tree") {
          result.branch = parts.slice(3).join("/")
        }
        return result
      }
    }
  } catch { /* not a URL */ }
  return undefined
}

function hdrs(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": process.env.GITHUBREPO_USER_AGENT ?? "GitHubCopilot/1.0",
  }
}

function getToolProxy(): string | undefined {
  const userProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (userProxy) return userProxy
  const proxyHost = process.env.PROXY_HOST
  const proxyPort = process.env.PROXY_PORT || "18289"
  if (proxyHost) return `http://${proxyHost}:${proxyPort}`
  return undefined
}

async function ghFetch(url: string, init: RequestInit & { signal?: AbortSignal } = {}) {
  return fetch(url, init)
}

function readOauthTokenFrom(path: string): string | undefined {
  try {
    const raw = readFileSync(path, "utf8")
    const data = JSON.parse(raw)
    if (data.oauth_token) return data.oauth_token as string
  } catch { /* token file not available */ }
  return undefined
}

async function getToken(): Promise<string | undefined> {
  // Fallback: shared token file (VS Code)
  const sharedOauth = readOauthTokenFrom(SHARED_TOKEN_PATH)
  if (sharedOauth) return sharedOauth

  if (process.env.GITHUBREPO_OPENCODE_AUTH_FALLBACK !== "false") {
    try {
      const authPath = join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json")
      const raw = readFileSync(authPath, "utf8")
      const data = JSON.parse(raw)
      const auth = data["github-copilot"]
      if (auth?.type === "oauth") return (auth.refresh ?? auth.access) as string | undefined
    } catch { /* opencode auth not available */ }
  }

  return undefined
}

interface IndexInfo {
  state: "ready" | "building" | "not-indexed" | "error"
  sha?: string
}

async function checkIndex(owner: string, repo: string, token: string, signal: AbortSignal): Promise<IndexInfo> {
  const response = await ghFetch(`${API}/repos/${owner}/${repo}/copilot_internal/embeddings_index`, {
    method: "GET",
    headers: hdrs(token),
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    console.error(`[githubrepo] checkIndex failed: HTTP ${response.status} — ${body.slice(0, 200)}`)
    return { state: "error" }
  }
  const data = await response.json()
  if (data.semantic_code_search_ok && data.semantic_commit_sha) return { state: "ready", sha: data.semantic_commit_sha }
  if (data.semantic_indexing_enabled) return { state: "building" }
  return { state: "not-indexed" }
}

async function triggerIndex(owner: string, repo: string, token: string, signal: AbortSignal): Promise<boolean> {
  const response = await ghFetch(`${API}/repos/${owner}/${repo}/copilot_internal/embeddings_index`, {
    method: "POST",
    headers: hdrs(token),
    body: JSON.stringify({ auto: false }),
    signal,
  })
  return response.ok
}

async function waitForIndex(owner: string, repo: string, token: string, signal: AbortSignal, attempts: number): Promise<IndexInfo> {
  for (let i = 0; i < attempts; i++) {
    await sleep(POLL_DELAY, signal)
    const info = await checkIndex(owner, repo, token, signal)
    if (info.state === "ready") return info
    if (info.state === "error") return info
  }
  return { state: "building" }
}

async function waitForReindex(owner: string, repo: string, oldSha: string, token: string, signal: AbortSignal, attempts: number): Promise<IndexInfo> {
  await triggerIndex(owner, repo, token, signal)
  for (let i = 0; i < attempts; i++) {
    await sleep(POLL_DELAY, signal)
    const info = await checkIndex(owner, repo, token, signal)
    if (info.state === "ready" && info.sha && info.sha !== oldSha) return info
    if (info.state === "error") return info
  }
  return { state: "building" }
}

async function getAuthUser(token: string, signal: AbortSignal): Promise<string | undefined> {
  const res = await ghFetch(`${API}/user`, { headers: hdrs(token), signal })
  if (!res.ok) return undefined
  const data = await res.json()
  return data.login
}

async function setDefaultBranch(owner: string, repo: string, branch: string, token: string, signal: AbortSignal): Promise<boolean> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}`, {
    method: "PATCH",
    headers: hdrs(token),
    body: JSON.stringify({ default_branch: branch }),
    signal,
  })
  return res.ok
}

function shadowName(repo: string, branch: string): string {
  const sanitized = branch.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 60)
  return `${SHADOW_PREFIX}-${repo}-${sanitized}`
}

async function createFork(owner: string, repo: string, forkName: string, token: string, signal: AbortSignal): Promise<boolean> {
  const res = await ghFetch(`${API}/repos/${owner}/${repo}/forks`, {
    method: "POST",
    headers: hdrs(token),
    body: JSON.stringify({ name: forkName, default_branch_only: false }),
    signal,
  })
  if (!res.ok) return false
  const login = (await getAuthUser(token, signal))!
  for (let i = 0; i < 30; i++) {
    await sleep(2000, signal)
    const c = await ghFetch(`${API}/repos/${login}/${forkName}`, { headers: hdrs(token), signal })
    if (c.ok) return true
  }
  return false
}

async function deleteShadow(owner: string, repo: string, token: string) {
  try {
    await ghFetch(`${API}/repos/${owner}/${repo}`, { method: "DELETE", headers: hdrs(token) })
  } catch { /* best-effort */ }
}

async function ensureShadow(
  login: string, owner: string, repo: string, branch: string, token: string, signal: AbortSignal,
  onStatus: (msg: string) => void,
): Promise<{ shadowOwner: string; shadowRepo: string }> {
  const sname = shadowName(repo, branch)
  const exists = await ghFetch(`${API}/repos/${login}/${sname}`, { headers: hdrs(token), signal })

  if (exists.ok) {
    const data = await exists.json()
    if (data.default_branch !== branch) {
      onStatus(`Updating shadow ${sname} default branch to "${branch}"...`)
      await setDefaultBranch(login, sname, branch, token, signal)
      const info = await checkIndex(login, sname, token, signal)
      if (info.sha) {
        onStatus(`Re-indexing shadow for branch "${branch}"...`)
        await waitForReindex(login, sname, info.sha, token, signal, Math.ceil(BRANCH_TIMEOUT / POLL_DELAY))
      }
    }
    return { shadowOwner: login, shadowRepo: sname }
  }

  const selfOwned = login.toLowerCase() === owner.toLowerCase()
  if (selfOwned) {
    onStatus(`Creating shadow ${sname} from ${owner}/${repo}:${branch}...`)
    const createRes = await ghFetch(`${API}/user/repos`, {
      method: "POST",
      headers: hdrs(token),
      body: JSON.stringify({
        name: sname,
        private: true,
        description: `Shadow repo for ${owner}/${repo} branch ${branch} (githubrepo tool)`,
        auto_init: false,
      }),
      signal,
    })
    if (!createRes.ok) {
      const body = await createRes.text()
      throw new Error(`Failed to create shadow repo ${sname}: ${body}`)
    }

    onStatus(`Importing ${owner}/${repo}:${branch} into shadow repo...`)
    const importRes = await ghFetch(`${API}/repos/${login}/${sname}/import`, {
      method: "PUT",
      headers: { ...hdrs(token), Accept: "application/vnd.github.barred-rock-preview" },
      body: JSON.stringify({ vcs: "git", vcs_url: `https://github.com/${owner}/${repo}.git` }),
      signal,
    })

    if (importRes.ok) {
      for (let i = 0; i < 60; i++) {
        await sleep(3000, signal)
        const statusRes = await ghFetch(`${API}/repos/${login}/${sname}/import`, { headers: hdrs(token), signal })
        if (!statusRes.ok) break
        const statusData = await statusRes.json()
        if (statusData.status === "complete") break
        if (statusData.status === "error") throw new Error(`Import failed: ${statusData.status_text}`)
      }
      await setDefaultBranch(login, sname, branch, token, signal)
    } else {
      await deleteShadow(login, sname, token)
      throw new Error(`Cannot create shadow repo for self-owned repo. GitHub import API returned ${importRes.status}.`)
    }
  } else {
    onStatus(`Forking ${owner}/${repo} as ${sname}...`)
    const created = await createFork(owner, repo, sname, token, signal)
    if (!created) throw new Error(`Failed to create shadow fork ${sname}.`)
    await setDefaultBranch(login, sname, branch, token, signal)
  }

  return { shadowOwner: login, shadowRepo: sname }
}

function buildScopingQuery(owner: string, repo: string, path?: string[], lang?: string[]): string {
  const parts = [`repo:${owner}/${repo}`]
  if (lang?.length) parts.push(...lang.map((item) => `lang:${item}`))
  if (path?.length) parts.push(...path.map((item) => `path:${item}`))
  return parts.join(" ")
}

interface SearchResult {
  chunk: { hash: string; text: string; range: { start: number; end: number }; line_range: { start: number; end: number } }
  distance: number
  location: { path: string; commit_sha: string; ref_name?: string; repo: { nwo: string; url: string } }
}

async function search(owner: string, repo: string, query: string, token: string, signal: AbortSignal, path?: string[], lang?: string[], opts?: { maxResults?: number; embeddingModel?: string }): Promise<SearchResult[]> {
  const encoder = new TextEncoder()
  let trimmed = query
  while (encoder.encode(trimmed).length > MAX_QUERY_BYTES) {
    trimmed = trimmed.slice(0, -100)
  }

  const response = await ghFetch(`${API}/embeddings/code/search`, {
    method: "POST",
    headers: hdrs(token),
    body: JSON.stringify({
      scoping_query: buildScopingQuery(owner, repo, path, lang),
      prompt: trimmed,
      include_embeddings: false,
      limit: opts?.maxResults ?? MAX_RESULTS,
      embedding_model: opts?.embeddingModel ?? EMBEDDING_MODEL,
    }),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Search failed (${response.status}): ${text}`)
  }

  const data = await response.json()
  return data.results ?? []
}

function dedupeAndFilter(results: SearchResult[]): SearchResult[] {
  if (!results.length) return results
  const sorted = [...results].sort((a, b) => a.distance - b.distance)
  const topScore = 1 - sorted[0].distance
  const filtered = sorted.filter((r) => (1 - r.distance) >= topScore - 0.65)
  const seen = new Map<string, Array<{ start: number; end: number }>>()
  const out: SearchResult[] = []
  for (const r of filtered) {
    const key = r.location.path
    const ranges = seen.get(key) ?? []
    if (ranges.some((e) => r.chunk.line_range.start < e.end && r.chunk.line_range.end > e.start)) continue
    ranges.push({ start: r.chunk.line_range.start, end: r.chunk.line_range.end })
    seen.set(key, ranges)
    out.push(r)
  }
  return out
}

function format(results: SearchResult[], owner: string, repo: string, branch?: string): string {
  if (results.length === 0) return "No results found."
  return results
    .map((r, i) => {
      const start = r.chunk.line_range.start
      const end = r.chunk.line_range.end
      const ref = branch ?? r.location.ref_name?.replace("refs/heads/", "") ?? "main"
      const url = `https://github.com/${owner}/${repo}/blob/${ref}/${r.location.path}#L${start}-L${end}`
      const score = (1 - r.distance).toFixed(3)
      return [
        `## Result ${i + 1} — ${r.location.path} (L${start}-L${end}) [score: ${score}]`,
        url,
        "```",
        r.chunk.text.trimEnd(),
        "```",
      ].join("\n")
    })
    .join("\n\n")
}

// ─── Plugin export ────────────────────────────────────────────────────────────

export const plugin: Plugin = async (_ctx) => {
  return {
    tool: {
      githubrepo: tool({
        description: DESCRIPTION,
        args: {
          repo: tool.schema.string().describe(
            "GitHub repository in 'owner/repo' format or full GitHub URL (supports /tree/branch-name)"
          ),
          query: tool.schema.string().describe("Semantic search query to find relevant code"),
          branch: tool.schema.string().describe(
            "Search a non-default branch. Creates a persistent shadow repo (tmp-ghrtool-{repo}-{branch}) for indexing. Disable with GITHUBREPO_BRANCH_SEARCH=false"
          ).optional(),
          path: tool.schema.array(tool.schema.string()).describe(
            "Filter by file paths, e.g. ['src/', 'README.md']"
          ).optional(),
          lang: tool.schema.array(tool.schema.string()).describe(
            "Filter by language, e.g. ['TypeScript', 'Python']"
          ).optional(),
        },
        async execute(params, ctx) {
          // Read config from file (updated by /githubrepo TUI command), env vars take precedence
          const cfg = readSearchConfig()
          const searchTimeout = envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000)
          const branchTimeout = envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000)
          const maxResults = Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64
          const embeddingModel = process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary"
          const pollAttemptsCfg = Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10
          const branchSearch = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"

          const signal = AbortSignal.any([ctx.abort, AbortSignal.timeout(searchTimeout)])
          try {
            const token = await getToken()
          if (!token) throw new Error("Not authenticated with GitHub Copilot. Run 'opencode auth' to log in.")

          const parsed = parseRepo(params.repo)
          if (!parsed) throw new Error(`Invalid repository format: "${params.repo}". Use "owner/repo" or a GitHub URL.`)

          const branch = params.branch ?? parsed.branch
          const needsBranch = !!branch && branchSearch
          const pollAttempts = needsBranch ? Math.ceil(branchTimeout / POLL_DELAY) : pollAttemptsCfg

          let searchOwner = parsed.owner
          let searchRepo = parsed.repo

          if (needsBranch) {
            const login = await getAuthUser(token, signal)
            if (!login) throw new Error("Cannot determine authenticated user for branch search.")
            const shadow = await ensureShadow(login, parsed.owner, parsed.repo, branch!, token, signal, (msg) => ctx.metadata({ title: msg }))
            searchOwner = shadow.shadowOwner
            searchRepo = shadow.shadowRepo
          }

          let info: IndexInfo
          try {
            info = await checkIndex(searchOwner, searchRepo, token, signal)
          } catch (err) {
            if (isAbortError(err, signal)) return "Search was aborted. Try again with a more specific query."
            throw err
          }

          if (info.state === "error") {
            throw new Error(`Cannot access repository ${searchOwner}/${searchRepo}. It may not exist or you may lack access.`)
          }

          if (info.state === "not-indexed") {
            const ok = await triggerIndex(searchOwner, searchRepo, token, signal)
            if (!ok) throw new Error(`Failed to trigger indexing for ${searchOwner}/${searchRepo}.`)
            if (needsBranch) {
              return `Indexing ${searchOwner}/${searchRepo} for branch ${branch}. Run the same search again in a minute — the shadow repo will be ready.`
            }
            info = await waitForIndex(searchOwner, searchRepo, token, signal, pollAttempts)
            if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.")
          } else if (info.state === "building") {
            if (needsBranch) {
              return `Index still building for ${searchOwner}/${searchRepo}. Try again in a minute.`
            }
            info = await waitForIndex(searchOwner, searchRepo, token, signal, pollAttempts)
            if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.")
          }

          const results = await search(searchOwner, searchRepo, params.query, token, signal, params.path, params.lang, { maxResults, embeddingModel })
          const deduped = dedupeAndFilter(results)
          const output = format(deduped, parsed.owner, parsed.repo, branch)
          const branchLabel = branch ? ` @ ${branch}` : ""
          const suffix = deduped.length === 1 ? " result" : " results"
          const title = results.length === deduped.length
            ? `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${params.query}" — ${results.length}${suffix}`
            : `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${params.query}" — ${results.length} raw, ${deduped.length} after quality filter`
          ctx.metadata({ title })
          return output
        } catch (err) {
          // Graceful abort: don't propagate timeout/abort errors as crashes
          if (isAbortError(err, signal)) {
            ctx.metadata({ title: `Search aborted` })
            return "Search was aborted due to timeout. Try a more specific query."
          }
          throw err
        }
        },
      }),
    },
  }
}

export default plugin
