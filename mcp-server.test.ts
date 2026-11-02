import { expect, test } from "bun:test"

test("MCP stdio initializes, lists tools, and rejects invalid calls", async () => {
  const proc = Bun.spawn([process.execPath, "mcp-server.ts"], {
    cwd: import.meta.dir,
    env: { ...process.env, GITHUBREPO_BRANCH_SEARCH: "false" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  })
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  async function request(id: number, method: string, params: object) {
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    proc.stdin.flush()
    while (!buffer.includes("\n")) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Server exited: ${await new Response(proc.stderr).text()}`)
      buffer += chunk.value
    }
    const end = buffer.indexOf("\n")
    const message = JSON.parse(buffer.slice(0, end))
    buffer = buffer.slice(end + 1)
    expect(message.id).toBe(id)
    return message
  }
  try {
    const init = await request(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
    expect(init.result.serverInfo.name).toBe("repotool")
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
    const list = await request(2, "tools/list", {})
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["repotool", "repotool_global"])
    const missing = await request(3, "tools/call", { name: "repotool", arguments: { repo: "owner/repo" } })
    expect(missing.result?.isError || missing.error).toBeTruthy()
    const wrongType = await request(6, "tools/call", { name: "repotool", arguments: { repo: 42, query: "test" } })
    expect(wrongType.result?.isError || wrongType.error).toBeTruthy()
    const unknown = await request(4, "tools/call", { name: "unknown", arguments: {} })
    expect(unknown.result?.isError || unknown.error).toBeTruthy()
    for (const args of [
      { repo: "owner/repo", query: "test", lang: ["TypeScript"] },
      { repo: "owner/repo", query: "test", branch: "other" },
      { repo: "https://github.com/owner/repo/tree/other", query: "test" },
    ]) {
      const response = await request(5, "tools/call", { name: "repotool", arguments: args })
      expect(response.result.isError).toBe(true)
    }
  } finally {
    proc.kill()
    await proc.exited
  }
}, 15000)
