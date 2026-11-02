#!/usr/bin/env bun
/**
 * Stdio MCP bridge for opencode-githubrepo so non-OpenCode hosts (jcode) can use it.
 * Reuses token/search helpers from index.ts.
 *
 * Tool name: repotool (was githubrepo; use repotool only).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import {
  getToken,
  parseRepo,
  checkIndex,
  verifyShadowIndex,
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
} from "./index.ts"

const DESCRIPTION = `Semantic code search across GitHub repositories using Copilot embeddings.
Use owner/repo or a full GitHub URL. Optional branch/path filters; lang is unsupported.
Formerly exposed as the githubrepo tool; prefer repotool.`

const TOOL_NAME = "repotool"

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    repo: {
      type: "string",
      description: "owner/repo or full GitHub URL (supports /tree/branch)",
    },
    query: { type: "string", description: "Semantic search query" },
    branch: { type: "string", description: "Non-default branch (shadow-repo mode)" },
    path: {
      type: "array",
      items: { type: "string" },
      description: "Path filters e.g. ['src/']",
    },
    lang: {
      type: "array",
      items: { type: "string" },
      description: "Unsupported; omit this parameter",
    },
  },
  required: ["repo", "query"],
} as const

const server = new Server(
  { name: "repotool", version: "1.0.13" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: TOOL_INPUT_SCHEMA,
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL_NAME) {
    return {
      content: [
        {
          type: "text",
          text: `Unknown tool: ${req.params.name}. Use ${TOOL_NAME} (githubrepo was renamed).`,
        },
      ],
      isError: true,
    }
  }
  const params = (req.params.arguments ?? {}) as {
    repo?: string
    query?: string
    branch?: string
    path?: string[]
    lang?: string[]
  }
  if (!params.repo || !params.query) {
    return { content: [{ type: "text", text: "repo and query are required" }], isError: true }
  }

  try {
    const cfg = readSearchConfig()
    const searchTimeout = envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000)
    const branchTimeout = envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000)
    const maxResults = Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64
    const embeddingModel =
      process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary"
    const pollAttemptsCfg = Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10
    const branchSearch = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"
    const signal = AbortSignal.timeout(searchTimeout)

    if ((params.branch ?? parseRepo(params.repo)?.branch) && !branchSearch) throw new Error("Branch search is disabled by GITHUBREPO_BRANCH_SEARCH=false.")
    if (coerceStringArray(params.lang)) throw new Error("Language filtering is not supported by the embeddings API. Omit lang.")
    const token = await getToken()
    if (!token) {
      throw new Error(
        "Not authenticated. Run `opencode auth login` (github-copilot) and/or `gh auth login` with repo scope.",
      )
    }

    const parsed = parseRepo(params.repo)
    if (!parsed) throw new Error(`Invalid repository format: "${params.repo}"`)

    const branch = params.branch ?? parsed.branch
    const needsBranch = !!branch && branchSearch
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

    const pathFilters = coerceStringArray(params.path)
    const langFilters = coerceStringArray(params.lang)
    const apiPath = pathFilters?.length ? undefined : pathFilters
    const apiLang = pathFilters?.length ? undefined : langFilters
    let results = await search(searchOwner, searchRepo, params.query, token, signal, apiPath, apiLang, {
      maxResults,
      embeddingModel,
    })
    results = filterResultsByPathPrefix(results, pathFilters)
    const deduped = dedupeAndFilter(results)
    const output = format(deduped, parsed.owner, parsed.repo, branch)
    return { content: [{ type: "text", text: output }] }
  } catch (err) {
    if (isAbortError(err)) {
      return { content: [{ type: "text", text: "Search aborted due to timeout." }], isError: true }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: "text", text: msg }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
