// v2/semantic-index-v2.test.mjs — deterministic regression tests for V2 index
// status / trigger / poll semantics (parity with host index.ts @ e9a7507).
// Fully offline: fake tokens, fake fetch, injected sleep — no credential reads,
// no `gh`, no timers. Run: bun test v2/semantic-index-v2.test.mjs

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

const { checkIndex, executeSearch, sanitizeUpstreamBody, waitForIndex } = await import("./core.mjs")

const AMBIENT = { ghOnly: process.env.GITHUBREPO_GH_ONLY, branchSearch: process.env.GITHUBREPO_BRANCH_SEARCH }
const restore = (key, value) => (value === undefined ? delete process.env[key] : (process.env[key] = value))
// Wrapper hosts export GITHUBREPO_GH_ONLY=1 / GITHUBREPO_BRANCH_SEARCH=true, which
// disable the OAuth-primary + scope-404-fallback paths under test. Scope the
// override to this file and restore ambient values afterwards.
beforeAll(() => {
  delete process.env.GITHUBREPO_GH_ONLY
  delete process.env.GITHUBREPO_BRANCH_SEARCH
})
afterAll(() => {
  restore("GITHUBREPO_GH_ONLY", AMBIENT.ghOnly)
  restore("GITHUBREPO_BRANCH_SEARCH", AMBIENT.branchSearch)
})

const OAUTH = "fake-oauth-token"
const GH = "fake-gh-token"
const SIGNAL = new AbortController().signal
const INDEX = "/copilot_internal/embeddings_index"
const SEARCH = "/embeddings/code/search"
const RESULT = {
  chunk: { text: "code()", line_range: { start: 1, end: 2 } },
  distance: 0.25,
  location: { path: "src/a.ts", ref_name: "refs/heads/main", commit_sha: "sha" },
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const LEAKY_JSON = '{"token":"supersecretvalue","authorization":"Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKE"}'
const BODY_404 = 'repository not found for "protected_org_ids" {"oauth_token":"supersecretvalue"}'

function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body, auth: init.headers?.Authorization }
    calls.push(call)
    return handler(call)
  }
  fn.calls = calls
  fn.index = () => calls.filter((c) => c.url.endsWith(INDEX))
  fn.search = () => calls.filter((c) => c.url.endsWith(SEARCH))
  return fn
}

const deps = (fetch, extra = {}) => ({
  token: OAUTH,
  tokens: { copilotOauth: OAUTH, gh: GH },
  fetch,
  sleep: async () => {},
  ...extra,
})
const hits = (results = [RESULT]) => json({ results })

describe("checkIndex current semantic fields", () => {
  const at = (body, status = 200) => ({ fetch: fakeFetch(() => json(body, status)) })

  test("semantic fields decide ready/building/not-indexed; 404 is ready; other non-ok is error", async () => {
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ semantic_code_search_ok: true, semantic_commit_sha: "abc" })))
      .toEqual({ state: "ready", sha: "abc" })
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ semantic_indexing_enabled: true }))).toEqual({ state: "building" })
    expect(await checkIndex("o", "r", "t", SIGNAL, at({}))).toEqual({ state: "not-indexed" })
    // Obsolete clusters/status/sha shape must not be treated as ready.
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ clusters: [{ id: 1 }], status: "building", sha: "old" })))
      .toEqual({ state: "not-indexed" })
    expect(await checkIndex("o", "r", "t", SIGNAL, at({ message: "Not Found" }, 404))).toEqual({ state: "ready" })
    for (const status of [403, 500]) {
      expect(await checkIndex("o", "r", "t", SIGNAL, at({ message: "nope" }, status))).toEqual({ state: "error" })
    }
  })
})

describe("executeSearch index flow", () => {
  test("index-status 404 goes straight to direct embeddings search (no trigger)", async () => {
    const fetch = fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : hits()))
    const out = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch))
    expect(out.text).toContain("src/a.ts")
    expect(fetch.index().map((c) => c.method)).toEqual(["GET"])
    expect(fetch.search().length).toBe(1)
    expect(fetch.search()[0].auth).toBe(`Bearer ${OAUTH}`)
  })

  test("not-indexed -> trigger accepted -> building -> ready, with {auto:false} body", async () => {
    let gets = 0
    const fetch = fakeFetch((c) => {
      if (!c.url.endsWith(INDEX)) return hits()
      if (c.method === "POST") return json({})
      gets += 1
      if (gets === 1) return json({})
      if (gets === 2) return json({ semantic_indexing_enabled: true })
      return json({ semantic_code_search_ok: true, semantic_commit_sha: "sha1" })
    })
    const out = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch))
    expect(out.text).toContain("src/a.ts")
    expect(gets).toBe(3) // initial not-indexed, one building poll, one ready poll
    const trigger = fetch.index().filter((c) => c.method === "POST")
    expect(trigger.length).toBe(1)
    expect(trigger[0].body).toBe(JSON.stringify({ auto: false }))
  })

  test("polling is bounded: exactly `attempts` checks, no unbounded extra probe", async () => {
    let checks = 0
    const io = { sleep: async () => {}, check: async () => (checks += 1, { state: "building" }) }
    expect(await waitForIndex("owner", "repo", OAUTH, SIGNAL, 3, io)).toEqual({ state: "building" })
    expect(checks).toBe(3)

    process.env.GITHUBREPO_POLL_ATTEMPTS = "3"
    try {
      const fetch = fakeFetch(() => json({ semantic_indexing_enabled: true }))
      await expect(executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch))).rejects.toThrow(
        /not ready after polling/
      )
      expect(fetch.calls.length).toBe(4) // 1 initial status + 3 bounded polls, no 5th probe
    } finally {
      delete process.env.GITHUBREPO_POLL_ATTEMPTS
    }
  })

  test("OAuth scope-404 retries the actual embeddings request with gh", async () => {
    const fetch = fakeFetch((c) => {
      if (c.url.endsWith(INDEX)) return json({ message: "Not Found" }, 404)
      if (c.auth === `Bearer ${OAUTH}`) return json({ message: 'repository not found for "protected_org_ids"' }, 404)
      return hits()
    })
    const out = await executeSearch({ repo: "me/private-repo", query: "code" }, deps(fetch))
    expect(out.text).toContain("src/a.ts")
    expect(fetch.search().map((c) => c.auth)).toEqual([`Bearer ${OAUTH}`, `Bearer ${GH}`])
    expect(fetch.index().length).toBe(1) // no extra index probe between attempts
  })
})

describe("branch shadow routing", () => {
  test("no branch => no shadow/self-user endpoint is touched", async () => {
    const fetch = fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : hits()))
    const noAuth = (what) => Promise.reject(new Error(`${what} must not run without a branch`))
    const out = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch, {
      getAuthUser: () => noAuth("getAuthUser"),
      ensureShadow: () => noAuth("ensureShadow"),
    }))
    expect(out.text).toContain("src/a.ts")
    const urls = fetch.calls.map((c) => c.url).join(" ")
    for (const forbidden of ["/user", "/forks", "/import", "tmp-ghrtool"]) expect(urls).not.toContain(forbidden)
  })

  test("explicit non-default branch uses (mocked) shadow orchestration", async () => {
    const shadowCalls = []
    const fetch = fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : hits()))
    const out = await executeSearch({ repo: "owner/repo", query: "code", branch: "feature/x" }, deps(fetch, {
      getAuthUser: async () => "me",
      ensureShadow: async (login, owner, repo, branch) => {
        shadowCalls.push({ login, owner, repo, branch })
        return { shadowOwner: login, shadowRepo: `tmp-ghrtool-${repo}-feature-x` }
      },
    }))
    expect(shadowCalls).toEqual([{ login: "me", owner: "owner", repo: "repo", branch: "feature/x" }])
    expect(out.text).toContain("src/a.ts")
    expect(fetch.search().length).toBe(1)
    expect(JSON.parse(fetch.search()[0].body).scoping_query).toBe("repo:me/tmp-ghrtool-repo-feature-x")
    for (const c of fetch.calls) expect(c.method).not.toBe("DELETE")
  })
})

describe("error redaction", () => {
  test("sanitizeUpstreamBody strips bearer/github tokens and token JSON fields, keeps bounded diagnostics", () => {
    const body =
      'status 500: {"authorization":"Bearer ghp_FAKEFAKEFAKEFAKEFAKEFAKE","access_token":"supersecretvalue","login":"octocat"}'
    const out = sanitizeUpstreamBody(body)
    expect(out).not.toContain("ghp_")
    expect(out).not.toContain("supersecretvalue")
    expect(out).toContain("[redacted]")
    expect(out).toContain("octocat")
    expect(out).toContain("status 500")
    const bounded = sanitizeUpstreamBody("x".repeat(600), 100)
    expect(bounded.length).toBeLessThan(200)
    expect(bounded).toContain("[truncated 500 chars]")
  })

  test("thrown search errors never expose upstream tokens", async () => {
    const leaky = (status) =>
      fakeFetch((c) => (c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : new Response(LEAKY_JSON, { status })))
    const err500 = await executeSearch({ repo: "owner/repo", query: "code" }, deps(leaky(500))).catch((e) => e)
    expect(err500.message).toContain("Search failed (500)")
    expect(err500.message).not.toContain("supersecretvalue")
    expect(err500.message).not.toContain("ghp_")

    const fetch404 = fakeFetch((c) =>
      c.url.endsWith(INDEX) ? json({ message: "Not Found" }, 404) : new Response(BODY_404, { status: 404 }))
    const err404 = await executeSearch({ repo: "owner/repo", query: "code" }, deps(fetch404, { tokens: {} })).catch((e) => e)
    expect(err404.message).toContain("token-scope issue")
    expect(err404.message).not.toContain("supersecretvalue")
  })
})
