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

  test("githubrepo TOKEN_SYNC mode refuses local auth fallback", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain("const SYNC_MODE = !!(SYNC_URL && SYNC_SECRET)")
    expect(src).toContain("TOKEN_SYNC active but no shared OAuth token is available. Refusing auth fallback")
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

  test("githubrepo branch shadow uses onStatus progress callback", () => {
    const src = readFileSync(PLUGIN, "utf8")
    expect(src).toContain('(msg) => ctx.metadata({ title: msg })')
  })
})
