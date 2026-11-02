#!/usr/bin/env bun
/**
 * Stdio MCP bridge for opencode-githubrepo so non-OpenCode hosts (jcode) can use it.
 * Reuses token/search helpers from index.ts.
 *
 * Tool name: repotool (was githubrepo; use repotool only).
 */
import { McpServer } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { z } from "zod/v4"
import {
  getToken,
  parseRepo,
  checkIndex,
  verifyShadowIndex,
  verifyShadowResults,
  triggerIndex,
  waitForIndex,
  ensureShadow,
  getAuthUser,
  search,
  dedupeAndFilter,
  format,
  filterResultsByPathPrefix,
  coerceStringArray,
  isAbortError,
  envMsOrCfgSeconds,
  readSearchConfig,
  POLL_DELAY,
  globalSearch,
} from "./index.ts"

const DESCRIPTION = `Semantic code search across GitHub repositories using Copilot embeddings.
Use owner/repo or a full GitHub URL. Optional branch and path filters; language filtering is unsupported.
Formerly exposed as the githubrepo tool; prefer repotool.`

const server = new McpServer({ name: "repotool", version: "1.0.13" })

server.registerTool("repotool", {
  description: DESCRIPTION,
  inputSchema: z.object({
    repo: z.string().min(1).describe("owner/repo or full GitHub URL (supports /tree/branch)"),
    query: z.string().min(1).describe("Semantic search query"),
    branch: z.string().optional().describe("Non-default branch (shadow-repo mode)"),
    path: z.array(z.string()).optional().describe("Path filters e.g. ['src/']"),
    lang: z.array(z.string()).optional().describe("Unsupported; omit this parameter"),
  }),
}, async (params, extra) => {
  try {
    if (params.lang?.length) throw new Error("Language filtering is not supported.")
    const parsed = parseRepo(params.repo)
    if (!parsed) throw new Error(`Invalid repository format: "${params.repo}"`)
    const branch = params.branch ?? parsed.branch
    const branchSearch = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"
    if (branch && !branchSearch) throw new Error("Branch search is disabled by GITHUBREPO_BRANCH_SEARCH.")
    const cfg = readSearchConfig()
    const searchTimeout = envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000)
    const branchTimeout = envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000)
    const maxResults = Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64
    const embeddingModel =
      process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary"
    const pollAttemptsCfg = Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10
    const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(searchTimeout)])

    const token = await getToken()
    if (!token) {
      throw new Error(
        "Not authenticated. Run `opencode auth login` (github-copilot) and/or `gh auth login` with repo scope.",
      )
    }

    const needsBranch = !!branch
    const pollAttempts = needsBranch ? Math.ceil(branchTimeout / POLL_DELAY) : pollAttemptsCfg

    let searchOwner = parsed.owner
    let searchRepo = parsed.repo
    let shadowSha: string | undefined

    if (needsBranch) {
      const login = await getAuthUser(token, signal)
      if (!login) throw new Error("Cannot determine authenticated user for branch search.")
      const shadow = await ensureShadow(
        login,
        parsed.owner,
        parsed.repo,
        branch!,
        token,
        signal,
        () => {},
      )
      searchOwner = shadow.shadowOwner
      searchRepo = shadow.shadowRepo
      shadowSha = shadow.sourceSha
    }

    let info = await checkIndex(searchOwner, searchRepo, token, signal)
    if (shadowSha) await verifyShadowIndex(info, shadowSha, searchOwner, searchRepo, token, signal)

    if (info.state === "error") {
      throw new Error(`Cannot access repository ${searchOwner}/${searchRepo}.`)
    }
    if (info.state === "not-indexed") {
      const ok = await triggerIndex(searchOwner, searchRepo, token, signal)
      if (!ok) throw new Error(`Failed to trigger indexing for ${searchOwner}/${searchRepo}.`)
      if (needsBranch) {
        return {
          content: [
            {
              type: "text",
              text: `Indexing ${searchOwner}/${searchRepo} for branch ${branch}. Retry in a minute.`,
            },
          ],
        }
      }
      info = await waitForIndex(searchOwner, searchRepo, token, signal, pollAttempts)
      if (info.state !== "ready") throw new Error("Repository index not ready after polling.")
    } else if (info.state === "building") {
      if (needsBranch) {
        return {
          content: [
            {
              type: "text",
              text: `Index still building for ${searchOwner}/${searchRepo}. Retry in a minute.`,
            },
          ],
        }
      }
      info = await waitForIndex(searchOwner, searchRepo, token, signal, pollAttempts)
      if (info.state !== "ready") throw new Error("Repository index not ready after polling.")
    }

    if (shadowSha) await verifyShadowIndex(info, shadowSha, searchOwner, searchRepo, token, signal)

    const pathFilters = coerceStringArray(params.path)
    const langFilters = coerceStringArray(params.lang)
    const apiPath = pathFilters?.length ? undefined : pathFilters
    const apiLang = pathFilters?.length ? undefined : langFilters
    let results = await search(searchOwner, searchRepo, params.query, token, signal, apiPath, apiLang, {
      maxResults,
      embeddingModel,
    })
    if (shadowSha) verifyShadowResults(results, shadowSha)
    results = filterResultsByPathPrefix(results, pathFilters)
    const deduped = dedupeAndFilter(results)
    const output = format(deduped, parsed.owner, parsed.repo, shadowSha ?? branch)
    return { content: [{ type: "text", text: output }] }
  } catch (err) {
    if (isAbortError(err)) {
      return { content: [{ type: "text", text: "Search aborted due to timeout." }], isError: true }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: "text", text: msg }], isError: true }
  }
})

server.registerTool("repotool_global", {
  description: "Discover up to five repositories by GitHub metadata and search their default branches semantically. Results are not exhaustive.",
  inputSchema: z.object({
    discovery: z.string().min(1).describe("GitHub repository metadata search query"),
    query: z.string().min(1).describe("Semantic code search query"),
    path: z.array(z.string()).optional().describe("Path prefixes"),
  }),
}, async (params, extra) => {
  try {
    const cfg = readSearchConfig()
    const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000))])
    signal.throwIfAborted()
    const token = await getToken()
    signal.throwIfAborted()
    if (!token) throw new Error("Not authenticated. Run `opencode auth login` or `gh auth login`.")
    return { content: [{ type: "text", text: await globalSearch(params.discovery, params.query, token, signal, params.path) }] }
  } catch (err) {
    return { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
})

await serveStdio(() => server)
