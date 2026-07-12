import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"
import {
  buildScopingQuery,
  coerceStringArray,
  filterResultsByPathPrefix,
  isEmbeddingsScopeDenied,
  pickPrimaryToken,
  pickScopeFallback,
} from "./index"
import type { SearchResult } from "./index"
import type { CopilotTokens } from "./index"

const PLUGIN = resolve(import.meta.dir, "index.ts")

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
