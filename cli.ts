#!/usr/bin/env bun
import { parseArgs } from "node:util"
import {
  parseRepo, getToken, checkIndex, triggerIndex, waitForIndex, search,
  dedupeAndFilter, filterResultsByPathPrefix, format, readSearchConfig,
  envMsOrCfgSeconds, isAbortError, globalSearch,
} from "./index.ts"

const help = `Usage: bun cli.ts [--path PREFIX] <owner/repo> <query>
       bun cli.ts --global [--path PREFIX] <metadata query> <semantic query>

Semantic search in one specified GitHub repository using Copilot embeddings.
Searches its default branch; --path may be repeated. Authentication and indexing
are required. Set GITHUBREPO_SEARCH_TIMEOUT in milliseconds to limit the search.

Options:
  --global       Discover up to 5 repositories using GitHub metadata search
  --path PREFIX  Filter results by path prefix
  -h, --help     Show this help
`

export async function run(args: string[], signal: AbortSignal): Promise<string> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: { help: { type: "boolean", short: "h" }, global: { type: "boolean" }, path: { type: "string", multiple: true } },
  })
  if (values.help) return help.trimEnd()
  if (positionals.length !== 2 || !positionals[1]?.trim()) throw new Error("Expected a repository and nonempty query. Use --help for usage.")
  const parsed = values.global ? undefined : parseRepo(positionals[0]!)
  if (!values.global && !parsed) throw new Error("Invalid repository. Use owner/repo or a GitHub URL.")
  if (parsed?.branch) throw new Error("CLI searches the default branch only; omit the branch from the repository URL.")
  if (values.global && !positionals[0]?.trim()) throw new Error("Discovery query must not be empty.")
  if (values.path?.some(path => !path.trim())) throw new Error("Path prefixes must not be empty.")
  const cfg = readSearchConfig()
  const timeout = AbortSignal.timeout(envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000))
  const combined = AbortSignal.any([signal, timeout])
  combined.throwIfAborted()
  const token = await getToken()
  combined.throwIfAborted()
  if (!token) throw new Error("Not authenticated. Run `opencode auth login` or `gh auth login`.")
  if (values.global) {
    const output = await globalSearch(positionals[0]!, positionals[1]!, token, combined, values.path)
    combined.throwIfAborted()
    return output
  }
  if (!parsed) throw new Error("Invalid repository.")
  let info = await checkIndex(parsed.owner, parsed.repo, token, combined)
  if (info.state === "error") throw new Error(`Cannot access repository ${parsed.owner}/${parsed.repo}.`)
  if (info.state === "not-indexed") {
    if (!await triggerIndex(parsed.owner, parsed.repo, token, combined)) throw new Error("Failed to trigger indexing.")
  }
  if (info.state === "building" || info.state === "not-indexed") {
    info = await waitForIndex(parsed.owner, parsed.repo, token, combined, Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10)
    if (info.state !== "ready") throw new Error("Repository index not ready after polling.")
  }
  const results = await search(parsed.owner, parsed.repo, positionals[1]!, token, combined, undefined, undefined, {
    maxResults: Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64,
    embeddingModel: process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary",
  })
  combined.throwIfAborted()
  return format(dedupeAndFilter(filterResultsByPathPrefix(results, values.path)), parsed.owner, parsed.repo)
}

if (import.meta.main) {
  const controller = new AbortController()
  let signalExit = 0
  const interrupt = (name: "SIGINT" | "SIGTERM") => {
    signalExit = name === "SIGINT" ? 130 : 143
    controller.abort(new Error(`Interrupted by ${name}.`))
  }
  const onInt = () => interrupt("SIGINT")
  const onTerm = () => interrupt("SIGTERM")
  process.once("SIGINT", onInt)
  process.once("SIGTERM", onTerm)
  try {
    console.log(await run(process.argv.slice(2), controller.signal))
  } catch (err) {
    const message = signalExit ? `Interrupted by ${signalExit === 130 ? "SIGINT" : "SIGTERM"}.` : isAbortError(err) || (err instanceof Error && err.name === "TimeoutError") ? "Search timed out." : err instanceof Error ? err.message : String(err)
    console.error(message)
    process.exitCode = signalExit || 1
  } finally {
    process.removeListener("SIGINT", onInt)
    process.removeListener("SIGTERM", onTerm)
  }
}
