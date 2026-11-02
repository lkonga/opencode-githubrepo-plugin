import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import githubrepoPiExtension from "./pi.ts";

// Minimal senpi/omo ExtensionAPI stub: capture registrations.
function stubPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any>();
  const notices: Array<{ msg: string; level?: string }> = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, opts: any) => commands.set(name, opts),
    on: (event: string, handler: any) => handlers.set(event, handler),
  };
  const ctx: any = {
    hasUI: true,
    ui: { notify: (msg: string, level?: string) => notices.push({ msg, level }) },
  };
  return { pi, ctx, tools, commands, handlers, notices };
}

describe("pi extension registration", () => {
  test("registers githubrepo tool with repo+query required (TypeBox schema)", () => {
    const { pi, tools } = stubPi();
    githubrepoPiExtension(pi);
    const tool = tools.get("githubrepo");
    expect(tool).toBeDefined();
    expect(tool.label).toBe("GitHub Repo Search");
    expect(tool.description).toContain("Copilot embeddings");
    // TypeBox object schema: properties carry the fields, required lists repo+query.
    expect(Object.keys(tool.parameters.properties)).toContain("repo");
    expect(Object.keys(tool.parameters.properties)).toContain("query");
    expect(tool.parameters.required).toContain("repo");
    expect(tool.parameters.required).toContain("query");
    expect(tool.parameters.required).not.toContain("branch");
    expect(Value.Check(tool.parameters, { repo: "o/r", query: "q" })).toBe(true);
    expect(Value.Check(tool.parameters, { query: "q" })).toBe(false);
    expect(Value.Check(tool.parameters, { repo: "o/r" })).toBe(false);
  });

  test("registers /githubrepo command and session_start handler", () => {
    const { pi, commands, handlers } = stubPi();
    githubrepoPiExtension(pi);
    expect(commands.has("githubrepo")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
  });

  test("/githubrepo handler notifies settings without leaking tokens", async () => {
    const { pi, ctx, commands, notices } = stubPi();
    githubrepoPiExtension(pi);
    await commands.get("githubrepo").handler("", ctx);
    expect(notices.length).toBe(1);
    const msg = notices[0].msg;
    expect(msg).toContain("Max results:");
    expect(msg).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
    expect(msg).not.toContain("gho_");
    expect(msg).not.toContain("github_pat_");
  });

  test("session_start notifies load", async () => {
    const { pi, ctx, handlers, notices } = stubPi();
    githubrepoPiExtension(pi);
    await handlers.get("session_start")({ type: "session_start" }, ctx);
    expect(notices.length).toBe(1);
    expect(notices[0].msg).toContain("githubrepo pi extension loaded");
  });

  test("execute rejects invalid repo before any network", async () => {
    const { pi, tools } = stubPi();
    githubrepoPiExtension(pi);
    const tool = tools.get("githubrepo");
    await expect(
      tool.execute("id", { repo: "not a repo!!!", query: "q" }, undefined, undefined, {}),
    ).rejects.toThrow("Invalid repository format");
  });
});


test("rejects disabled branch and unsupported language before auth", async () => {
  const previous = process.env.GITHUBREPO_BRANCH_SEARCH
  process.env.GITHUBREPO_BRANCH_SEARCH = "false"
  try {
    const { pi, tools } = stubPi()
    githubrepoPiExtension(pi)
    const execute = (params: any) => tools.get("githubrepo").execute("id", params, undefined, undefined, {})
    await expect(execute({ repo: "o/r", query: "q", branch: "dev" })).rejects.toThrow("Branch search is disabled")
    await expect(execute({ repo: "https://github.com/o/r/tree/dev", query: "q" })).rejects.toThrow("Branch search is disabled")
    await expect(execute({ repo: "o/r", query: "q", path: ["src"], lang: ["Python"] })).rejects.toThrow("Language filtering is not supported")
  } finally {
    if (previous === undefined) delete process.env.GITHUBREPO_BRANCH_SEARCH
    else process.env.GITHUBREPO_BRANCH_SEARCH = previous
  }
})
