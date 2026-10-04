// v2/server.mjs — OpenCode V2 backend plugin for opencode-githubrepo.
//
// Uses ONLY public V2 plugin APIs:
//   - exports the V2 promise plugin shape { id, setup } (loader schema:
//     packages/core/src/plugin/supervisor.ts PluginModule struct)
//   - registers tools through ctx.tool.transform(draft => draft.add(tool))
//     (packages/plugin/src/promise/tool.ts ToolDraft / adapter.ts)
//   - tool input is a plain JSON Schema; V2 decodes non-schema values
//     as-is (packages/core/src/tool/runtime.ts decodeInput)
//   - execute returns { content, metadata } (packages/schema/src/tool.ts Result)
//
// Behaviour is a line-for-line port of the V1 plugin tool (index.ts @ e9a7507):
// same tool name `githubrepo`, same description, same search pipeline.

import { addProgressSink, DESCRIPTION, executeSearch } from "./core.mjs"

export const TOOL_NAME = "githubrepo"
export const PLUGIN_ID = "opencode-githubrepo-v2"

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    repo: {
      type: "string",
      description: "GitHub repository in 'owner/repo' format or full GitHub URL (supports /tree/branch-name)",
    },
    query: { type: "string", description: "Semantic search query to find relevant code" },
    branch: {
      type: "string",
      description:
        "Search a non-default branch. Creates a persistent shadow repo (tmp-ghrtool-{repo}-{branch}) for indexing. Disable with GITHUBREPO_BRANCH_SEARCH=false",
    },
    path: {
      type: "array",
      items: { type: "string" },
      description: "Filter by file paths, e.g. ['src/', 'README.md']",
    },
    lang: {
      type: "array",
      items: { type: "string" },
      description: "Filter by language, e.g. ['TypeScript', 'Python']",
    },
  },
  required: ["repo", "query"],
}

async function execute(input, toolContext) {
  const removeSink = toolContext?.progress
    ? addProgressSink(toolContext.progress)
    : undefined
  try {
    const { text, title } = await executeSearch(input)
    // metadata (title) is the V2 equivalent of V1's ctx.metadata({ title })
    return { content: text, metadata: { title } }
  } finally {
    removeSink?.()
  }
}

export async function setupGithubrepoV2(ctx) {
  const registrations = []
  if (typeof ctx?.tool?.transform !== "function") {
    throw new Error(
      `[${PLUGIN_ID}] V2 tool domain unavailable — cannot register ${TOOL_NAME} tool. Public V2 API: ctx.tool.transform (packages/plugin/src/promise/tool.ts).`
    )
  }
  registrations.push(
    await ctx.tool.transform((draft) => {
      draft.add({
        name: TOOL_NAME,
        description: DESCRIPTION,
        input: INPUT_SCHEMA,
        execute,
      })
    }),
  )
  return async () => {
    for (const registration of registrations.reverse()) {
      try {
        await registration?.dispose?.()
      } catch {
        /* dispose is best-effort during unload */
      }
    }
  }
}

export default {
  id: PLUGIN_ID,
  setup: setupGithubrepoV2,
}