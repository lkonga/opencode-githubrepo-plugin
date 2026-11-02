import { describe, expect, test } from "bun:test"
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { resolve } from "path"
import {
  globalSearch,
  buildScopingQuery,
  coerceStringArray,
  filterResultsByPathPrefix,
  isEmbeddingsScopeDenied,
  pickPrimaryToken,
  pickScopeFallback,
  search,
  plugin,
  ensureShadow,
  verifyShadowIndex,
  verifyShadowResults,
  format,
} from "./index"
import type { SearchResult } from "./index"
import type { CopilotTokens } from "./index"

const PLUGIN = resolve(import.meta.dir, "index.ts")

describe("managed shadows", () => {
  const sha = "a".repeat(40)
  async function exercise(options: { gitLogin?: string; collision?: boolean; stale?: boolean; sourceStatus?: number; branch?: string; id?: number; shadowStatus?: number; private?: boolean | null; index404?: boolean; triggerFails?: boolean; synchronize?: boolean } = {}) {
    const original = globalThis.fetch
    const calls: { url: string; method: string; body?: any; authorization?: string }[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input), method = init?.method ?? "GET"
      calls.push({ url, method, body: init?.body && JSON.parse(String(init.body)), authorization: new Headers(init?.headers).get('authorization') ?? undefined })
      if (url.endsWith('/user')) return Response.json({ login: options.gitLogin ?? 'me' })
      if (url.endsWith("/repos/source/project")) return options.sourceStatus ? new Response("", { status: options.sourceStatus }) : Response.json({ id: options.id ?? 7, private: options.private === null ? undefined : options.private ?? false })
      if (url.includes("/repos/source/project/git/ref/heads/")) return Response.json({ object: { sha } })
      if (url.endsWith("/embeddings_index")) return method === "POST" ? (options.triggerFails ? new Response("", { status: 403 }) : Response.json({})) : options.index404 ? new Response("", { status: 404 }) : Response.json({ semantic_code_search_ok: true, semantic_commit_sha: options.stale ? "b".repeat(40) : sha })
      if (url.includes("/git/ref/")) return Response.json({ object: { sha: options.synchronize && calls.filter(c => c.url.includes("/git/ref/") && !c.url.includes("/source/project/")).length === 1 ? "b".repeat(40) : sha } })
      const name = url.split("/").pop()!
      if (options.shadowStatus) return new Response("", { status: options.shadowStatus })
      const hash = name.slice(-64)
      return Response.json({ private: !options.collision, description: `githubrepo-shadow-v1:${hash}`, owner: { login: "me" }, default_branch: "githubrepo-shadow", fork: false })
    }) as typeof fetch
    try {
      const result = await ensureShadow("me", "source", "project", options.branch ?? "feature/a", "secret", new AbortController().signal, () => {})
      return { result, calls }
    } catch (error) {
      return { error: String(error), calls }
    } finally { globalThis.fetch = original }
  }
  test("reuses verified private shadow and distinguishes branch and source identity", async () => {
    const a = await exercise(), b = await exercise({ branch: "feature-a" }), c = await exercise({ id: 8 })
    expect(a.result?.sourceSha).toBe(sha)
    expect(new Set([a.result?.shadowRepo, b.result?.shadowRepo, c.result?.shadowRepo]).size).toBe(3)
    expect(a.calls.every(c => c.method === "GET")).toBe(true)
  })
  test("rejects collisions and inaccessible sources without mutation", async () => {
    for (const options of [{ collision: true }, { sourceStatus: 403 }, { shadowStatus: 403 }]) {
      const result = await exercise(options)
      expect(result.error).toBeDefined()
      expect(result.calls.every(c => c.method === "GET")).toBe(true)
    }
  })
  test("requires explicit opt-in for private or unknown visibility sources", async () => {
    const previous = process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW
    try {
      delete process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW
      for (const visibility of [true, null] as const) {
        const result = await exercise({ private: visibility })
        expect(result.error).toContain("GITHUBREPO_ALLOW_PRIVATE_SHADOW=true")
        expect(result.calls).toHaveLength(1)
      }
      process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW = "1"
      expect((await exercise({ private: true })).error).toBeDefined()
      process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW = "true"
      expect((await exercise({ private: true })).result?.sourceSha).toBe(sha)
    } finally {
      if (previous === undefined) delete process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW
      else process.env.GITHUBREPO_ALLOW_PRIVATE_SHADOW = previous
    }
  })
  test("every search entrypoint requires the exact shadow SHA", () => {
    for (const file of ["index.ts", "mcp-server.ts", "omo.ts", "omp.ts", "pi.ts"]) {
      const src = readFileSync(resolve(import.meta.dir, file), "utf8")
      const lastPoll = src.lastIndexOf("info = await waitForIndex(searchOwner, searchRepo")
      const verification = src.indexOf("if (shadowSha) await verifyShadowIndex(info, shadowSha, searchOwner, searchRepo, token,", lastPoll)
      const searchCall = src.indexOf("await search(searchOwner, searchRepo", lastPoll)
      expect(lastPoll).toBeGreaterThan(-1)
      expect(verification).toBeGreaterThan(lastPoll)
      expect(searchCall).toBeGreaterThan(verification)
      expect(src.indexOf('verifyShadowResults(results, shadowSha)', searchCall)).toBeGreaterThan(searchCall)
      expect(src).toContain('format(deduped, parsed.owner, parsed.repo, shadowSha ?? branch)')
    }
  })
  test("rejects unverifiable shadow index even when 404 permits normal search", async () => {
    const result = await exercise({ index404: true })
    expect(result.error).toContain("Cannot verify shadow index SHA")
    expect(result.calls.filter(c => c.method === "POST" && c.url.endsWith("/embeddings_index"))).toHaveLength(1)
    expect(result.calls.some(c => c.url.includes("embeddings/code/search"))).toBe(false)
  })
  test("surfaces failed triggers for missing and stale shadow SHAs", async () => {
    for (const options of [{ index404: true }, { stale: true }]) {
      const result = await exercise({ ...options, triggerFails: true })
      expect(result.error).toContain("Failed to trigger indexing")
      expect(result.calls.filter(c => c.method === "POST" && c.url.endsWith("/embeddings_index"))).toHaveLength(1)
    }
  })
  test("rechecks the SHA at search entrypoints", async () => {
    const original = globalThis.fetch
    let posts = 0
    globalThis.fetch = (async () => { posts++; return new Response("", { status: 503 }) }) as typeof fetch
    try {
      const signal = new AbortController().signal
      await verifyShadowIndex({ state: "ready", sha }, sha, "me", "repo", "token", signal)
      expect(posts).toBe(0)
      for (const info of [{ state: "ready" as const }, { state: "ready" as const, sha: "b".repeat(40) }]) {
        await expect(verifyShadowIndex(info, sha, "me", "repo", "token", signal)).rejects.toThrow("Failed to trigger indexing")
      }
      expect(posts).toBe(2)
    } finally { globalThis.fetch = original }
  })
  test("rejects mismatched or missing result SHAs and pins links", () => {
    const result = { location: { commit_sha: sha, path: 'a.ts' }, chunk: { line_range: { start: 1, end: 2 }, text: 'code' }, distance: 0 } as SearchResult
    verifyShadowResults([result], sha)
    expect(format([result], 'source', 'project', sha)).toContain(`/blob/${sha}/a.ts`)
    for (const commit_sha of ['b'.repeat(40), undefined]) {
      expect(() => verifyShadowResults([{ ...result, location: { ...result.location, commit_sha } } as SearchResult], sha)).toThrow('unverified commit')
    }
  })
  test("git receives the gh token only through its environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "githubrepo-test-"))
    const oldPath = process.env.PATH, oldGh = process.env.GH_TOKEN, oldTrace = process.env.GIT_TRACE
    const log = join(dir, "log")
    try {
      writeFileSync(join(dir, "git"), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$GH_TOKEN" "$GIT_TRACE" "$*" >> '${log}'\ncase "$*" in *rev-parse*) printf '${sha}\\n';; esac\n`)
      chmodSync(join(dir, "git"), 0o700)
      writeFileSync(join(dir, "gh"), "#!/bin/sh\nprintf 'git-token\\n'\n")
      chmodSync(join(dir, "gh"), 0o700)
      process.env.PATH = `${dir}:${oldPath}`
      process.env.GH_TOKEN = "wrong-token"
      process.env.GIT_TRACE = "1"
      const result = await exercise({ synchronize: true })
      expect(result.result?.sourceSha).toBe(sha)
      expect(result.calls.find(c => c.url.endsWith('/user'))?.authorization).toBe('Bearer git-token')
      expect(result.calls.filter(c => !c.url.endsWith('/user')).every(c => c.authorization === 'Bearer secret')).toBe(true)
      const mismatch = await exercise({ synchronize: true, gitLogin: 'other' })
      expect(mismatch.error).toContain('identity does not match')
      const lines = readFileSync(log, "utf8").trim().split("\n")
      expect(lines.length).toBe(4)
      for (const line of lines) {
        const [token, trace, args] = line.split("|")
        expect(token).toBe("git-token")
        expect(trace).toBe("")
        expect(args).not.toContain("secret")
        expect(args).not.toContain("git-token")
        expect(args).not.toContain("wrong-token")
      }
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
      if (oldGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldGh
      if (oldTrace === undefined) delete process.env.GIT_TRACE; else process.env.GIT_TRACE = oldTrace
      rmSync(dir, { recursive: true, force: true })
    }
  })
  test("never searches a known stale index", async () => {
    const result = await exercise({ stale: true })
    expect(result.error).toContain("stale")
    expect(result.calls.some(c => c.method === "POST" && c.url.endsWith("/embeddings_index"))).toBe(true)
  })
})

test("global discovery is bounded and reports per-repository failures", async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/search/repositories')) {
      expect(new URL(url).searchParams.get('per_page')).toBe('5')
      return Response.json({ incomplete_results: true, items: ['a/one', 'b/two', 'c/three', 'd/four', 'e/five', 'f/six'].map(full_name => ({ full_name })) })
    }
    if (url.includes('embeddings_index')) return Response.json({ semantic_code_search_ok: true, semantic_commit_sha: 'sha' })
    if (url.includes('/embeddings/code/search')) {
      const body = JSON.parse(String(init?.body))
      if (body.scoping_query.includes('b/two')) return new Response('unavailable', { status: 500 })
      return Response.json({ results: [{ chunk: { hash: 'h', text: 'matched code', range: { start: 0, end: 1 }, line_range: { start: 1, end: 2 } }, distance: 0.1, location: { path: 'src/file.ts', commit_sha: 'sha', repo: { nwo: 'a/one', url: '' } } }] })
    }
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch
  try {
    const output = await globalSearch('topic:test', 'query', 'token', new AbortController().signal)
    expect(output).toContain('GitHub reported incomplete discovery')
    expect(output).toContain('### a/one\n## Result 1')
    expect(output).toContain('matched code')
    expect(output).toContain('### b/two\nSearch failed:')
    expect(output).toContain('Searched 4 of 5 candidates successfully; results are partial')
    expect(calls.some(url => url.includes('f/six'))).toBe(false)
    expect(calls.filter(url => url.includes('/embeddings/code/search'))).toHaveLength(5)
  } finally { globalThis.fetch = original }
})

test("global discovery reports rate limits", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response('', { status: 429 })) as typeof fetch
  try {
    await expect(globalSearch('test', 'query', 'token', new AbortController().signal)).rejects.toThrow('429')
  } finally { globalThis.fetch = original }
})

test("global discovery skips malformed names and marks partial results", async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url)
    if (url.includes('/search/repositories')) return Response.json({ items: [null, { full_name: 'https://github.com/a/b' }, { full_name: 'a/..' }, { full_name: 'a/b?x' }, { full_name: 'good/repo' }] })
    if (url.includes('embeddings_index')) return Response.json({ semantic_code_search_ok: true, semantic_commit_sha: 'sha' })
    return Response.json({ results: [] })
  }) as typeof fetch
  try {
    const output = await globalSearch('test', 'query', 'token', new AbortController().signal)
    expect(output).toContain('skipped 4 malformed')
    expect(output).toContain('Searched 1 of 1 candidates successfully; results are partial')
    expect(calls.filter(url => url.includes('embeddings_index'))).toHaveLength(1)
  } finally { globalThis.fetch = original }
})

test.each(['check', 'trigger', 'poll', 'search'])('global search stops on %s rate limit retaining prior results', async (stage) => {
  const original = globalThis.fetch
  const calls: string[] = []
  let checks = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url)
    if (url.includes('/search/repositories')) return Response.json({ items: ['a/one', 'b/two', 'c/three'].map(full_name => ({ full_name })) })
    if (url.includes('/repos/a/')) return Response.json({ semantic_code_search_ok: true, semantic_commit_sha: 'sha' })
    if (url.includes('/repos/b/')) {
      if (init?.method === 'POST') return stage === 'trigger' ? new Response('rate limit', { status: 403 }) : new Response('', { status: 200 })
      checks++
      if (stage === 'check' || (stage === 'poll' && checks > 1)) return new Response('', { status: 429 })
      if (stage === 'trigger' || stage === 'poll') return Response.json({})
      return Response.json({ semantic_code_search_ok: true, semantic_commit_sha: 'sha' })
    }
    if (url.includes('/embeddings/code/search')) {
      const body = JSON.parse(String(init?.body))
      if (stage === 'search' && body.scoping_query.includes('b/two')) return new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
      return Response.json({ results: [] })
    }
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch
  try {
    const output = await globalSearch('test', 'query', 'token', new AbortController().signal)
    expect(output).toContain('### a/one')
    expect(output).toContain('stopped after a rate limit')
    expect(output).toContain('Searched 1 of 3 candidates successfully; results are partial')
    expect(calls.some(url => url.includes('/repos/c/'))).toBe(false)
  } finally { globalThis.fetch = original }
})

test('global search continues after a non-rate-limit 403', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/search/repositories')) return Response.json({ items: ['a/one', 'b/two'].map(full_name => ({ full_name })) })
    if (url.includes('/repos/a/')) return new Response('forbidden', { status: 403 })
    if (url.includes('embeddings_index')) return Response.json({ semantic_code_search_ok: true, semantic_commit_sha: 'sha' })
    return Response.json({ results: [] })
  }) as typeof fetch
  try {
    const output = await globalSearch('test', 'query', 'token', new AbortController().signal)
    expect(output).toContain('index (403)')
    expect(output).toContain('### b/two')
    expect(output).toContain('Searched 1 of 2 candidates successfully; results are partial')
  } finally { globalThis.fetch = original }
})

describe("githubrepo safety source guards", () => {
  test("githubrepo has a ghFetch wrapper", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("async function ghFetch(")
    expect(src).toContain("return fetch(url, init)")
  })

  test("githubrepo resolves auth: token-sync, shared token, OpenCode auth.json, gh", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("readOpencodeCopilotOauth")
    expect(src).toContain("token-sync-live.json")
    expect(src).toContain("copilot-shared-token")
    expect(src).toContain("gh auth token")
  })

  test("githubrepo discovers auth: optional overrides then upstream vanilla auth.json", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("GITHUBREPO_AUTH_JSON")
    expect(src).toContain("authJson")
    expect(src).toContain("opencodeAuthJsonPaths")
    expect(src).toContain('join(defaultShareDir(), "opencode", "auth.json")')
    expect(src).toMatch(/xdgAuth !== vanilla/)
  })

  test("githubrepo routes all GitHub API calls through ghFetch", () => {
    const src = readFileSync(PLUGIN, "utf8")
    const directApiFetches = src
      .split("\n")
      .filter((line) => line.includes("fetch(`${API}") && !line.includes("ghFetch("))
    expect(directApiFetches).toEqual([])
  })

  test("githubrepo handles abort gracefully via try/catch", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("try {")
    expect(src).toContain("AbortError")
    expect(src).toContain('"Search was aborted due to timeout')
  })

  test("githubrepo title ternary has no nested ternary", () => {
    const src = readFileSync(PLUGIN, "utf8")
    const titleLine = src.split("\n").filter((l) => l.includes("const title = results.length"))
    expect(titleLine.length).toBe(1)
    expect(titleLine[0]).not.toContain('? `')
  })

  test("githubrepo treats embeddings_index 404 as search-ready (index probe optional)", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("response.status === 404")
    expect(src).toMatch(/404[\s\S]{0,120}state:\s*"ready"/)
  })

  test("githubrepo branch shadow uses onStatus progress callback", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain('(msg) => ctx.metadata({ title: msg })')
  })

  test("githubrepo makes token-sync / shared-token opt-in only (SYNC_MODE) and supports PREFER_GH", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("if (SYNC_MODE) {")
    expect(src).toContain("GITHUBREPO_PREFER_GH")
    expect(src).toContain("pickPrimaryToken")
    expect(src).toContain("pickScopeFallback")
    // scope-404 retry is bidirectional (not hardcoded to gh)
    expect(src).toContain("pickScopeFallback(token, resolveCopilotTokens())")
  })
})

describe("search input safety", () => {
  test("rejects unsupported language filters before network", async () => {
    await expect(search("o", "r", "q", "token", new AbortController().signal, ["src"], ["TypeScript"])).rejects.toThrow("Language filtering is not supported")
  })

  test("truncates UTF-8 without splitting a character", async () => {
    const original = globalThis.fetch
    let prompt = ""
    globalThis.fetch = (async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).prompt
      return Response.json({ results: [] })
    }) as typeof fetch
    try {
      await search("o", "r", "a".repeat(7799) + "😀" + "z", "token", new AbortController().signal)
      expect(prompt).toBe("a".repeat(7799))
    } finally {
      globalThis.fetch = original
    }
  })

  test("OpenCode rejects disabled explicit and URL branches and lang before auth", async () => {
    const previous = process.env.GITHUBREPO_BRANCH_SEARCH
    process.env.GITHUBREPO_BRANCH_SEARCH = "false"
    try {
      const tool = (await plugin({} as any)).tool!.githubrepo
      const ctx = { abort: new AbortController().signal, metadata: () => {} } as any
      for (const repo of ["o/r", "https://github.com/o/r/tree/dev"]) {
        await expect(tool.execute({ repo, query: "q", ...(repo === "o/r" ? { branch: "dev" } : {}) }, ctx)).rejects.toThrow("Branch search is disabled")
      }
      await expect(tool.execute({ repo: "o/r", query: "q", lang: ["Python"] }, ctx)).rejects.toThrow("Language filtering is not supported")
    } finally {
      if (previous === undefined) delete process.env.GITHUBREPO_BRANCH_SEARCH
      else process.env.GITHUBREPO_BRANCH_SEARCH = previous
    }
  })
})

describe("githubrepo token selection — pickPrimaryToken", () => {
  const oauth = "copilot-oauth-aaa"
  const gh = "gh-token-bbb"
  const both: CopilotTokens = { copilotOauth: oauth, gh }

  test("defaults to Copilot OAuth first (entitlement-gated public repos)", () => {
    expect(pickPrimaryToken(both, false)).toBe(oauth)
  })

  test("prefers gh when preferGh=true (private-repo-heavy use)", () => {
    expect(pickPrimaryToken(both, true)).toBe(gh)
  })

  test("falls back to the other token when one is missing", () => {
    expect(pickPrimaryToken({ gh }, false)).toBe(gh)
    expect(pickPrimaryToken({ copilotOauth: oauth }, true)).toBe(oauth)
  })

  test("returns undefined when neither token is available", () => {
    expect(pickPrimaryToken({}, false)).toBeUndefined()
    expect(pickPrimaryToken({}, true)).toBeUndefined()
  })
})

describe("githubrepo scope-404 retry — pickScopeFallback", () => {
  const oauth = "copilot-oauth-aaa"
  const gh = "gh-token-bbb"
  const both: CopilotTokens = { copilotOauth: oauth, gh }

  test("returns gh when primary was Copilot OAuth (92ce410 default behavior)", () => {
    expect(pickScopeFallback(oauth, both)).toBe(gh)
  })

  test("returns Copilot OAuth when primary was gh (PREFER_GH reversed direction)", () => {
    expect(pickScopeFallback(gh, both)).toBe(oauth)
  })

  test("returns undefined when no other token exists (no retry possible)", () => {
    expect(pickScopeFallback(oauth, { copilotOauth: oauth })).toBeUndefined()
    expect(pickScopeFallback(gh, { gh })).toBeUndefined()
  })

  test("never returns the same token as the primary", () => {
    expect(pickScopeFallback(oauth, both)).not.toBe(oauth)
    expect(pickScopeFallback(gh, both)).not.toBe(gh)
  })

  test("uses gh then oauth when primary is an unknown token (SYNC/env path)", () => {
    expect(pickScopeFallback("sync-or-env-token", both)).toBe(gh)
    expect(pickScopeFallback("sync-or-env-token", { copilotOauth: oauth })).toBe(oauth)
  })
})

describe("githubrepo embeddings scope-404 detection — isEmbeddingsScopeDenied", () => {
  test("matches 404 repository-not-found carrying protected_org_ids", () => {
    expect(isEmbeddingsScopeDenied(404, '{"message":"repository not found","protected_org_ids":[]}')).toBe(true)
  })

  test("rejects 404 without protected_org_ids (plain Not Found = bad owner/repo, not a scope issue)", () => {
    expect(isEmbeddingsScopeDenied(404, '{"message":"Not Found"}')).toBe(false)
    expect(isEmbeddingsScopeDenied(404, "repository not found")).toBe(false)
  })

  test("rejects non-404 statuses even if the body text matches", () => {
    expect(isEmbeddingsScopeDenied(401, '{"message":"repository not found","protected_org_ids":[]}')).toBe(false)
    expect(isEmbeddingsScopeDenied(500, "repository not found protected_org_ids")).toBe(false)
  })
})

describe("githubrepo path whitelist helpers", () => {
  test("coerceStringArray accepts array or string", () => {
    expect(coerceStringArray(["sessions"])).toEqual(["sessions"])
    expect(coerceStringArray("sessions")).toEqual(["sessions"])
    expect(coerceStringArray(undefined)).toBeUndefined()
  })

  test("buildScopingQuery is repo-only even when path/lang passed", () => {
    expect(buildScopingQuery("lkonga", "ocsearchv2")).toBe("repo:lkonga/ocsearchv2")
    expect(buildScopingQuery("lkonga", "ocsearchv2", ["sessions"], ["Markdown"])).toBe(
      "repo:lkonga/ocsearchv2",
    )
  })

  test("filterResultsByPathPrefix keeps sessions only", () => {
    const mk = (path: string): SearchResult => ({
      chunk: { hash: "", text: "x", range: { start: 0, end: 0 }, line_range: { start: 1, end: 2 } },
      distance: 0.1,
      location: { path, commit_sha: "c", repo: { nwo: "lkonga/ocsearchv2", url: "" } },
    })
    const out = filterResultsByPathPrefix(
      [mk("manifest.json"), mk("sessions/ses_a.md"), mk("scripts/x")],
      ["sessions"],
    )
    expect(out.map((r) => r.location.path)).toEqual(["sessions/ses_a.md"])
  })
})
