/**
 * githubrepo TUI — /githubrepo slash command for configuring search settings
 *
 * Opens a dialog to configure search timeout, branch timeout, and other
 * flags for the githubrepo semantic search tool.
 *
 * Settings are persisted to $OPENCODE_CONFIG_DIR/githubrepo-config.json
 * and read by the server plugin on each invocation.
 */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"

const CONFIG_FILE = "githubrepo-config.json"

function configPath(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR || `${require("os").homedir()}/.config/opencode`
  return `${dir}/${CONFIG_FILE}`
}

function readConfig(): Record<string, string> {
  try {
    const { readFileSync, existsSync } = require("fs") as typeof import("fs")
    const path = configPath()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

function writeConfig(config: Record<string, string>): void {
  const { writeFileSync, mkdirSync, existsSync } = require("fs") as typeof import("fs")
  const { dirname } = require("path") as typeof import("path")
  const path = configPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8")
}

const tui: TuiPlugin = async (api) => {
  api.command.register(() => [
    {
      title: "GitHub Repo Search Settings",
      value: "githubrepo.settings",
      category: "Fork",
      slash: { name: "githubrepo", aliases: ["ghrepo", "ghrs"] },
      onSelect: () => showDialog(api),
    },
  ])
}

function showDialog(api: any): void {
  const config = readConfig()

  const options = [
    {
      title: `Search Timeout: ${config.searchTimeout || "120"}s`,
      value: "searchTimeout",
      description: "Max time (seconds) to wait for search results. Env: GITHUBREPO_SEARCH_TIMEOUT",
    },
    {
      title: `Branch Timeout: ${config.branchTimeout || "180"}s`,
      value: "branchTimeout",
      description: "Max time (seconds) for non-default branch search. Env: GITHUBREPO_BRANCH_TIMEOUT",
    },
    {
      title: `Max Results: ${config.maxResults || "64"}`,
      value: "maxResults",
      description: "Max search results returned. Env: GITHUBREPO_MAX_RESULTS",
    },
    {
      title: `Embedding Model: ${config.embeddingModel || "metis-1024-I16-Binary"}`,
      value: "embeddingModel",
      description: "Copilot embedding model. Env: GITHUBREPO_EMBEDDING_MODEL",
    },
    {
      title: `Poll Attempts: ${config.pollAttempts || "10"}`,
      value: "pollAttempts",
      description: "Index poll retries. Env: GITHUBREPO_POLL_ATTEMPTS",
    },
    { title: "Reset to Defaults", value: "reset", category: "Actions" },
    { title: "Cancel", value: "cancel", category: "Navigation" },
  ]

  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() =>
    api.ui.DialogSelect({
      title: "GitHub Repo Settings",
      options,
      onSelect: (opt: any) => {
        if (!opt) return
        if (opt.value === "cancel") return

        if (opt.value === "reset") {
          writeConfig({})
          api.ui.toast({ variant: "info", message: "GitHubrepo settings reset to defaults" })
          showDialog(api)
          return
        }

        const isNumeric = ["searchTimeout", "branchTimeout", "maxResults", "pollAttempts"].includes(opt.value)

        api.ui.dialog.replace(() =>
          api.ui.DialogPrompt({
            title: `Set ${opt.title.split(":")[0]}`,
            value: (opt.title.match(/: (.+)s?$/)?.[1] || "").replace(/s$/i, ""),
            placeholder: isNumeric ? "Enter a positive integer" : "Enter new value",
            onConfirm: (value: string) => {
              if (!value) return
              const clean = isNumeric ? value.replace(/\D/g, "") : value
              if (isNumeric && (!clean || Number(clean) < 1)) {
                api.ui.toast({ variant: "error", message: `Must be a positive integer` })
                return
              }
              const newConfig = readConfig()
              const key =
                opt.value === "searchTimeout"
                  ? "searchTimeout"
                  : opt.value === "branchTimeout"
                    ? "branchTimeout"
                    : opt.value === "maxResults"
                      ? "maxResults"
                      : opt.value === "embeddingModel"
                        ? "embeddingModel"
                        : opt.value === "pollAttempts"
                          ? "pollAttempts"
                          : undefined
              if (key) newConfig[key] = clean
              writeConfig(newConfig)
              showDialog(api)
              api.ui.toast({ variant: "info", message: `GitHubrepo: ${opt.title.split(":")[0]} set to ${value}` })
            },
            onCancel: () => showDialog(api),
          }),
        )
      },
    }),
  )
}

export const id = "opencode-githubrepo-tui"

export default {
  id,
  tui,
} satisfies TuiPluginModule & { id: string }
