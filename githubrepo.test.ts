import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

const ROOT = resolve(__dirname, "..")
const PLUGIN = "/home/lkonga/codes/opencode-plugins/opencode-githubrepo/index.ts"

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

  test("githubrepo discovers auth via env, config authJson, XDG_DATA_HOME, upstream default", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("GITHUBREPO_AUTH_JSON")
    expect(src).toContain("authJson")
    expect(src).toContain("opencodeAuthJsonPaths")
    expect(src).toContain("process.env.XDG_DATA_HOME")
    expect(src).toContain('join(defaultShareDir(), "opencode", "auth.json")')
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
})
