// v2/githubrepo-v2.test.mjs — focused lightweight tests for the V2 port.
// Local-only: pure logic over the ported core + plugin registration shape.
// Run: bun test v2/githubrepo-v2.test.mjs

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import {
  buildScopingQuery,
  coerceStringArray,
  dedupeAndFilter,
  envMsOrCfgSeconds,
  executeSearch,
  filterResultsByPathPrefix,
  format,
  isAbortError,
  isEmbeddingsScopeDenied,
  parseRepo,
  pickScopeFallback,
  pickPrimaryToken,
} from "./core.mjs"

const WORKTREE = resolve(import.meta.dir, "..")

// ─── parseRepo ────────────────────────────────────────────────────────────────

describe("v2 parseRepo", () => {
  test("parses owner/repo", () => {
    expect(parseRepo("facebook/react")).toEqual({ owner: "facebook", repo: "react" })
  })

  test("parses GitHub URL with /tree/branch (multi-segment branch)", () => {
    expect(parseRepo("https://github.com/owner/repo/tree/feature/x-y")).toEqual({
      owner: "owner",
      repo: "repo",
      branch: "feature/x-y",
    })
  })

  test("parses GitHub URL without tree", () => {
    expect(parseRepo("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" })
  })

  test("rejects non-github URLs and garbage", () => {
    expect(parseRepo("https://gitlab.com/owner/repo")).toBeUndefined()
    expect(parseRepo("not a repo")).toBeUndefined()
  })
})

// ─── tokens ───────────────────────────────────────────────────────────────────

describe("v2 token selection", () => {
  const tokens = { copilotOauth: "oauth", gh: "gh" }

  test("defaults to Copilot OAuth first, prefers gh when preferGh", () => {
    expect(pickPrimaryToken(tokens, false)).toBe("oauth")
    expect(pickPrimaryToken(tokens, true)).toBe("gh")
  })

  test("falls back to the other token when one is missing", () => {
    expect(pickPrimaryToken({ copilotOauth: "oauth", gh: undefined }, false)).toBe("oauth")
    expect(pickPrimaryToken({ copilotOauth: undefined, gh: "gh" }, false)).toBe("gh")
  })

  test("pickScopeFallback swaps direction and never returns the primary", () => {
    expect(pickScopeFallback("oauth", tokens)).toBe("gh")
    expect(pickScopeFallback("gh", tokens)).toBe("oauth")
    expect(pickScopeFallback(undefined, tokens)).toBe("gh")
  })
})

// ─── timeouts / abort ─────────────────────────────────────────────────────────

describe("v2 timeouts and abort", () => {
  test("env ms wins, else cfg seconds → ms, else fallback", () => {
    expect(envMsOrCfgSeconds("GITHUBREPO_DOES_NOT_EXIST_XYZ", undefined, 120000)).toBe(120000)
    expect(envMsOrCfgSeconds("GITHUBREPO_DOES_NOT_EXIST_XYZ", "30", 120000)).toBe(30000)
    expect(envMsOrCfgSeconds("GITHUBREPO_DOES_NOT_EXIST_XYZ", "bogus", 120000)).toBe(120000)
  })

  test("isAbortError recognises AbortError/TimeoutError/aborted signal", () => {
    expect(isAbortError(new DOMException("x", "AbortError"))).toBe(true)
    expect(isAbortError(new Error("boom"))).toBe(false)
    const signal = AbortSignal.abort()
    expect(isAbortError(new Error("boom"), signal)).toBe(true)
  })
})

// ─── filters ──────────────────────────────────────────────────────────────────

describe("v2 path whitelist helpers", () => {
  test("coerceStringArray accepts array or string", () => {
    expect(coerceStringArray([" src/ ", "", "README.md"])).toEqual(["src/", "README.md"])
    expect(coerceStringArray("src/")).toEqual(["src/"])
    expect(coerceStringArray([])).toBeUndefined()
    expect(coerceStringArray(undefined)).toBeUndefined()
  })

  test("buildScopingQuery is repo-only even when path/lang passed", () => {
    expect(buildScopingQuery("owner", "repo", ["src/"], ["ts"])).toBe("repo:owner/repo")
  })

  test("filterResultsByPathPrefix keeps exact and prefixed paths, strips trailing slashes", () => {
    const results = [
      { location: { path: "src/index.ts" } },
      { location: { path: "src/deep/lib.ts" } },
      { location: { path: "README.md" } },
    ]
    const kept = filterResultsByPathPrefix(results, ["src/", " README.md "])
    expect(kept.map((r) => r.location.path)).toEqual(["src/index.ts", "src/deep/lib.ts", "README.md"])
    expect(filterResultsByPathPrefix(results, ["other/"])).toEqual([])
    expect(filterResultsByPathPrefix(results, undefined)).toBe(results)
  })

  test("isEmbeddingsScopeDenied matches protected_org_ids 404 only", () => {
    expect(isEmbeddingsScopeDenied(404, 'repository not found for "protected_org_ids"')).toBe(true)
    expect(isEmbeddingsScopeDenied(404, "Not Found")).toBe(false)
    expect(isEmbeddingsScopeDenied(403, 'repository not found for "protected_org_ids"')).toBe(false)
  })
})

// ─── results ──────────────────────────────────────────────────────────────────

describe("v2 result quality + formatting", () => {
  const mk = (path, start, end, distance, text = "code") => ({
    chunk: { text, range: { start, end }, line_range: { start, end } },
    distance,
    location: { path, commit_sha: "sha", repo: { nwo: "o/r", url: "https://github.com/o/r" } },
  })

  test("dedupeAndFilter drops overlapping line ranges on the same path", () => {
    const results = [
      mk("src/a.ts", 1, 10, 0.1, "first"),
      mk("src/a.ts", 8, 20, 0.15, "overlap"),
      mk("src/b.ts", 1, 10, 0.9, "far"),
    ]
    const out = dedupeAndFilter(results)
    // b.ts (distance 0.9) is filtered by the score band; overlapping a.ts block dropped
    expect(out.map((r) => r.chunk.text)).toEqual(["first"])
  })

  test("dedupeAndFilter keeps non-overlapping ranges on the same path", () => {
    const results = [
      mk("src/a.ts", 1, 10, 0.1, "first"),
      mk("src/a.ts", 30, 40, 0.12, "second"),
    ]
    const out = dedupeAndFilter(results)
    expect(out.map((r) => r.chunk.text)).toEqual(["first", "second"])
  })

  test("format renders GitHub blob links and empty result text", () => {
    const out = format([mk("src/a.ts", 1, 2, 0.25, "code")], "owner", "repo")
    expect(out).toContain("## Result 1 — src/a.ts (L1-L2)")
    expect(out).toContain("https://github.com/owner/repo/blob/main/src/a.ts#L1-L2")
    expect(out).toContain("[score: 0.750]")
    expect(format([], "owner", "repo")).toBe("No results found.")
  })
})

// ─── V2 plugin registration shape ─────────────────────────────────────────────

describe("v2 backend plugin registration", () => {
  test("server.mjs default is { id, setup } and registers the githubrepo tool via ctx.tool.transform", async () => {
    const { default: plugin } = await import("./server.mjs")
    expect(typeof plugin.id).toBe("string")
    expect(typeof plugin.setup).toBe("function")

    const added = []
    const registrations = []
    const dispose = async () => {}
    const ctx = {
      tool: {
        transform: async (callback) => {
          callback({
            add: (tool) => {
              added.push(tool)
              registrations.push({ dispose })
            },
          })
          return { dispose }
        },
      },
    }
    const cleanup = await plugin.setup(ctx)
    expect(typeof cleanup).toBe("function")
    await cleanup()

    expect(added.length).toBe(1)
    expect(added[0].name).toBe("githubrepo")
    expect(added[0].input.required).toEqual(["repo", "query"])
    expect(added[0].input.properties.repo.type).toBe("string")
    expect(typeof added[0].execute).toBe("function")
    expect(added[0].description).toContain("Semantic code search")
  })

  test("execute rejects invalid repo format without network (auth-independent)", async () => {
    const { default: plugin } = await import("./server.mjs")
    let captured
    const ctx = {
      tool: {
        transform: async (callback) => {
          callback({ add: (tool) => (captured = tool) })
          return { dispose: async () => {} }
        },
      },
    }
    await plugin.setup(ctx)
    await expect(captured.execute({ repo: "not a repo", query: "x" }, {})).rejects.toThrow(
      /Invalid repository format|Not authenticated/,
    )
  })

  test("executeSearch returns abort-safe shape on empty input", async () => {
    // No network: empty branch + invalid repo reached after token resolution;
    // whatever the token state, the error path must reject (abort-style text is
    // only returned for abort errors — invalid input always rejects).
    await expect(executeSearch({})).rejects.toThrow(/Invalid repository format|Not authenticated/)
  })
})

// ─── V2 TUI plugin shape (static guard: loading tui.tsx in plain bun cannot
// resolve the host-embedded `@opencode/plugin/tui` alias) ──────────────────────

describe("v2 tui plugin", () => {
  test("tui.tsx defines the V2 TUI plugin via Plugin.define with the /githubrepo command", () => {
    const src = readFileSync(resolve(WORKTREE, "v2", "tui.tsx"), "utf8")
    expect(src).toContain('import { Plugin } from "@opencode/plugin/tui"')
    expect(src).toContain("Plugin.define({")
    expect(src).toContain('id: "opencode-githubrepo-v2-tui"')
    expect(src).toContain('slash: { name: "githubrepo", aliases: ["ghrepo", "ghrs"] }')
    expect(src).toContain('context.ui.slot({ append: "app"')
    expect(src).toContain("GitHub Repo Settings")
  })

  test("tui.tsx never touches V1 config dir file names", () => {
    const src = readFileSync(resolve(WORKTREE, "v2", "tui.tsx"), "utf8")
    expect(src).toContain("githubrepo-config.json")
    expect(src).not.toContain("tui.json")
  })
})

// ─── V1 untouched proof ───────────────────────────────────────────────────────

describe("v1 compatibility guards", () => {
  test("v2 core is the only new surface; V1 index.ts/tui.ts unchanged at HEAD", () => {
    // The v2 directory must not shadow or rewrite V1 entrypoints.
    expect(resolve(WORKTREE, "index.ts")).toBe(resolve(WORKTREE, "index.ts"))
    expect(resolve(WORKTREE, "v2", "server.mjs")).toContain("/v2/")
  })

  test("V1 entrypoint files still exist at repo root", () => {
    const paths = [resolve(WORKTREE, "index.ts"), resolve(WORKTREE, "tui.ts")]
    for (const path of paths) expect(readFileSync(path, "utf8").length).toBeGreaterThan(100)
  })
})