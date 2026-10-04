// v2/tui.tsx — OpenCode V2 TUI plugin for opencode-githubrepo.
//
// Uses ONLY public V2 plugin APIs:
//   - `@opencode/plugin/tui` `Plugin.define({ id, setup })` — the embedded
//     V2 TUI plugin surface (see opencode-pool-guard/v2/tui.tsx and
//     opencode-execsa/v2/tui.tsx reference ports; runtime alias installed by
//     the host's plugin runtime support).
//   - setup renders a command-owning component through
//     context.ui.slot({ append: "app", ... })
//   - the /githubrepo command is registered via context.keymap.layer with
//     slash + palette entries (packages/plugin/src/tui/context.ts KeymapCommand)
//   - settings dialog via context.ui.dialog.select / prompt / alert and
//     context.ui.toast.show
//
// Behaviour mirrors the V1 tui.ts: same slash command (githubrepo with
// aliases ghrepo/ghrs), same options, same validation, same config file
// (githubrepo-config.json under $OPENCODE_CONFIG_DIR — the V2 config dir
// when running under oc2, so V1's file is never touched).

import { Plugin } from "@opencode/plugin/tui"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

const CONFIG_FILE = "githubrepo-config.json"
const NUMERIC_KEYS = ["searchTimeout", "branchTimeout", "maxResults", "pollAttempts"]

function configPath() {
  const dir = process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
  return join(dir, CONFIG_FILE)
}

function readConfig() {
  try {
    const path = configPath()
    if (!existsSync(path)) return {}
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return {}
  }
}

function writeConfig(config) {
  const path = configPath()
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8")
}

function optionEntries(config) {
  return [
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
}

function labelFor(value) {
  const labels = {
    searchTimeout: "Search Timeout",
    branchTimeout: "Branch Timeout",
    maxResults: "Max Results",
    embeddingModel: "Embedding Model",
    pollAttempts: "Poll Attempts",
  }
  return labels[value] ?? value
}

async function showDialog(context) {
  const config = readConfig()

  const action = await context.ui.dialog.select({
    title: "GitHub Repo Settings",
    options: optionEntries(config),
  })
  if (!action || action === "cancel") return

  if (action === "reset") {
    writeConfig({})
    context.ui.toast.show({ variant: "info", message: "GitHubrepo settings reset to defaults" })
    return showDialog(context)
  }

  const isNumeric = NUMERIC_KEYS.includes(action)
  const current = config[action] ?? ""
  const value = await context.ui.dialog.prompt({
    title: `Set ${labelFor(action)}`,
    value: isNumeric ? String(current).replace(/s$/i, "") : String(current),
    placeholder: isNumeric ? "Enter a positive integer" : "Enter new value",
  })
  if (value === undefined) return

  const clean = isNumeric ? value.replace(/\D/g, "") : value
  if (isNumeric && (!clean || Number(clean) < 1)) {
    context.ui.toast.show({ variant: "error", message: "Must be a positive integer" })
    return
  }
  writeConfig({ ...readConfig(), [action]: clean })
  context.ui.toast.show({ variant: "info", message: `GitHubrepo: ${labelFor(action)} set to ${value}` })
  return showDialog(context)
}

function Commands(props) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "githubrepo.settings",
        title: "GitHub Repo Search Settings",
        description: "Configure search timeout, branch timeout, and other githubrepo search flags",
        group: "Fork",
        palette: true,
        slash: { name: "githubrepo", aliases: ["ghrepo", "ghrs"] },
        run: () => showDialog(props.context),
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: "opencode-githubrepo-v2-tui",
  setup: (context) =>
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> }),
})
