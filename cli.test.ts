import { describe, expect, test } from "bun:test"

const cli = `${import.meta.dir}/cli.ts`
async function invoke(...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

describe("CLI", () => {
  test("help is on stdout", async () => {
    const result = await invoke("--help")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("Usage:")
    expect(result.stderr).toBe("")
  })
  test.each([[], ["bad", "query"], ["owner/repo", ""], ["--unknown"]])("invalid arguments fail: %j", async (...args) => {
    const result = await invoke(...args)
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).not.toBe("")
  })
  test("rejects an already aborted search", async () => {
    const { run } = await import("./cli.ts")
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(run(["owner/repo", "query"], controller.signal)).rejects.toThrow("cancelled")
  })
  test("searches and filters through existing helpers", async () => {
    const script = `
      import { mock } from 'bun:test';
      mock.module('./index.ts', () => ({
        parseRepo: () => ({ owner: 'o', repo: 'r' }), getToken: async () => 'token',
        checkIndex: async () => ({ state: 'ready' }), triggerIndex: async () => true,
        waitForIndex: async () => ({ state: 'ready' }), search: async (...args) => {
          if (args[2] !== 'query') throw Error('wrong query');
          return ['src/a', 'other/b'];
        },
        filterResultsByPathPrefix: (results, paths) => results.filter(x => x.startsWith(paths[0])),
        dedupeAndFilter: x => x, format: x => x.join(','), readSearchConfig: () => ({}),
        envMsOrCfgSeconds: () => 1000, isAbortError: () => false,
      }));
      const { run } = await import('./cli.ts');
      console.log(await run(['--path', 'src/', 'o/r', 'query'], new AbortController().signal));
    `
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ stdout, stderr, code }).toEqual({ stdout: "src/a\n", stderr: "", code: 0 })
  })
})
