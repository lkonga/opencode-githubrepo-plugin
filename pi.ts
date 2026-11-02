/**
 * omo extension entry for opencode-githubrepo.
 *
 * Upstream strategy: `index.ts` (opencode plugin) and `tui.ts` (opencode TUI
 * command) are untouched. This module registers the same semantic-search
 * pipeline (`parseRepo` → shadow/index → `search` → filter/format from
 * `./index.ts`) through the senpi/omo `ExtensionAPI`, so one npm package serves
 * all hosts. Enable via package.json `pi.extensions`.
 *
 * Differences from `omp.ts` (oh-my-pi host):
 * - senpi `ToolDefinition.parameters` is a TypeBox schema, not zod: built with
 *   `Type` from "typebox" (a senpi virtual module, also a real dependency).
 * - senpi `ExtensionAPI` has no `pi.zod` and no `pi.logger`: logging is dropped
 *   (title travels in result `details`), shadow progress uses a no-op callback.
 */
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { Type } from "typebox";
import {
  POLL_DELAY,
  checkIndex,
  verifyShadowIndex,
  verifyShadowResults,
  coerceStringArray,
  dedupeAndFilter,
  ensureShadow,
  envMsOrCfgSeconds,
  filterResultsByPathPrefix,
  format,
  getAuthUser,
  getToken,
  isAbortError,
  parseRepo,
  readSearchConfig,
  resolveCopilotTokens,
  search,
  triggerIndex,
  waitForIndex,
} from "./index.ts";

const DESCRIPTION = `Semantic code search across GitHub repositories using Copilot embeddings.
Use owner/repo or a full GitHub URL. Optional branch/path filters; lang is unsupported.`;

/** Params are untyped (`unknown`) at the senpi boundary until validated, so
 *  annotate once here. Runtime validation happens in the omo host before
 *  `execute` runs. */
interface GithubrepoParams {
  repo: string;
  query: string;
  branch?: string;
  path?: string[];
  lang?: string[];
}

const PARAMS_SCHEMA = Type.Object({
  repo: Type.String({
    description:
      "GitHub repository in 'owner/repo' format or full GitHub URL (supports /tree/branch-name)",
  }),
  query: Type.String({ description: "Semantic search query to find relevant code" }),
  branch: Type.Optional(
    Type.String({
      description:
        "Search a non-default branch. Creates a persistent shadow repo (tmp-ghrtool-{hash}) for indexing. Disable with GITHUBREPO_BRANCH_SEARCH=false",
    }),
  ),
  path: Type.Optional(
    Type.Array(Type.String(), {
      description: "Filter by file paths, e.g. ['src/', 'README.md']",
    }),
  ),
  lang: Type.Optional(
    Type.Array(Type.String(), {
      description: "Unsupported; omit this parameter",
    }),
  ),
});

export default function githubrepoPiExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "githubrepo",
    label: "GitHub Repo Search",
    description: DESCRIPTION,
    parameters: PARAMS_SCHEMA,
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      void toolCallId;
      const p = params as GithubrepoParams;
      // Config mirrors index.ts: file values, env vars take precedence.
      const cfg = readSearchConfig();
      const searchTimeout = envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000);
      const branchTimeout = envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000);
      const maxResults = Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64;
      const embeddingModel = process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary";
      const pollAttemptsCfg = Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10;
      const branchSearch = (process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false";

      const timeoutSignal = AbortSignal.timeout(searchTimeout);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        if ((p.branch ?? parseRepo(p.repo)?.branch) && !branchSearch) throw new Error("Branch search is disabled by GITHUBREPO_BRANCH_SEARCH=false.");
        if (coerceStringArray(p.lang)) throw new Error("Language filtering is not supported by the embeddings API. Omit lang.");
        const token = await getToken();
        if (!token) {
          throw new Error(
            "Not authenticated for GitHub Copilot embeddings. Run `opencode auth login` and choose github-copilot, and/or `gh auth login` (repo scope for private repos).",
          );
        }

        const parsed = parseRepo(p.repo);
        if (!parsed) throw new Error(`Invalid repository format: "${p.repo}". Use "owner/repo" or a GitHub URL.`);

        const branch = p.branch ?? parsed.branch;
        const needsBranch = !!branch && branchSearch;
        const pollAttempts = needsBranch ? Math.ceil(branchTimeout / POLL_DELAY) : pollAttemptsCfg;

        let searchOwner = parsed.owner;
        let searchRepo = parsed.repo;
        let shadowSha: string | undefined;

        if (needsBranch) {
          const login = await getAuthUser(token, combined);
          if (!login) throw new Error("Cannot determine authenticated user for branch search.");
          const shadow = await ensureShadow(
            login,
            parsed.owner,
            parsed.repo,
            branch!,
            token,
            combined,
            () => {},
          );
          searchOwner = shadow.shadowOwner;
          searchRepo = shadow.shadowRepo;
          shadowSha = shadow.sourceSha;
        }

        let info = await checkIndex(searchOwner, searchRepo, token, combined).catch((err) => {
          if (isAbortError(err, combined)) throw err;
          throw err;
        });

        if (shadowSha) await verifyShadowIndex(info, shadowSha, searchOwner, searchRepo, token, combined);

        if (info.state === "error") {
          throw new Error(`Cannot access repository ${searchOwner}/${searchRepo}. It may not exist or you may lack access.`);
        }

        if (info.state === "not-indexed") {
          const ok = await triggerIndex(searchOwner, searchRepo, token, combined);
          if (!ok) throw new Error(`Failed to trigger indexing for ${searchOwner}/${searchRepo}.`);
          if (needsBranch) {
            return {
              content: [
                {
                  type: "text",
                  text: `Indexing ${searchOwner}/${searchRepo} for branch ${branch}. Run the same search again in a minute — the shadow repo will be ready.`,
                },
              ],
              details: { state: info.state, branch },
            };
          }
          info = await waitForIndex(searchOwner, searchRepo, token, combined, pollAttempts);
          if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.");
        } else if (info.state === "building") {
          if (needsBranch) {
            return {
              content: [{ type: "text", text: `Index still building for ${searchOwner}/${searchRepo}. Try again in a minute.` }],
              details: { state: info.state, branch },
            };
          }
          info = await waitForIndex(searchOwner, searchRepo, token, combined, pollAttempts);
          if (info.state !== "ready") throw new Error("Repository index not ready after polling. Try again shortly.");
        }

        if (shadowSha) await verifyShadowIndex(info, shadowSha, searchOwner, searchRepo, token, combined);

        const pathFilters = coerceStringArray(p.path);
        const langFilters = coerceStringArray(p.lang);
        // Repo-only scoping + client prefix filter (path:/lang: in scoping_query 404s on some private repos).
        const apiPath = pathFilters?.length ? undefined : pathFilters;
        const apiLang = pathFilters?.length ? undefined : langFilters;
        let results = await search(searchOwner, searchRepo, p.query, token, combined, apiPath, apiLang, {
          maxResults,
          embeddingModel,
        });
        if (shadowSha) verifyShadowResults(results, shadowSha);
        results = filterResultsByPathPrefix(results, pathFilters);
        const deduped = dedupeAndFilter(results);
        const output = format(deduped, parsed.owner, parsed.repo, shadowSha ?? branch);
        const branchLabel = branch ? ` @ ${branch}` : "";
        const suffix = deduped.length === 1 ? " result" : " results";
        const title =
          results.length === deduped.length
            ? `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${p.query}" — ${results.length}${suffix}`
            : `Searched ${parsed.owner}/${parsed.repo}${branchLabel} for "${p.query}" — ${results.length} raw, ${deduped.length} after quality filter`;
        return { content: [{ type: "text", text: output }], details: { title, count: deduped.length } };
      } catch (err) {
        if (isAbortError(err, combined)) {
          return {
            content: [{ type: "text", text: "Search was aborted due to timeout. Try a more specific query." }],
            details: { aborted: true },
          };
        }
        throw err;
      }
    },
  });

  pi.registerCommand("githubrepo", {
    description: "Show githubrepo search settings and auth status",
    handler: async (_args, ctx) => {
      // Read-only status: values only, never token material.
      const cfg = readSearchConfig();
      const tokens = resolveCopilotTokens();
      const lines = [
        `Search timeout: ${envMsOrCfgSeconds("GITHUBREPO_SEARCH_TIMEOUT", cfg.searchTimeout, 120000) / 1000}s`,
        `Branch timeout: ${envMsOrCfgSeconds("GITHUBREPO_BRANCH_TIMEOUT", cfg.branchTimeout, 180000) / 1000}s`,
        `Max results: ${Number(process.env.GITHUBREPO_MAX_RESULTS || cfg.maxResults) || 64}`,
        `Embedding model: ${process.env.GITHUBREPO_EMBEDDING_MODEL || cfg.embeddingModel || "metis-1024-I16-Binary"}`,
        `Poll attempts: ${Number(process.env.GITHUBREPO_POLL_ATTEMPTS || cfg.pollAttempts) || 10}`,
        `Branch search: ${(process.env.GITHUBREPO_BRANCH_SEARCH ?? "true") !== "false"}`,
        `Copilot OAuth: ${tokens.copilotOauth ? "yes" : "no"}`,
        `gh CLI token: ${tokens.gh ? "yes" : "no"}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.notify("githubrepo pi extension loaded", "info");
  });
}
