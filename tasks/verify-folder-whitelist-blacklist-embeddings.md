# Verify folder whitelist/blacklist semantics for ocsearchv2 embeddings

## Goal

Make `githubrepo` searches against private `lkonga/ocsearchv2` return session files only, and state precisely which folder controls belong to the Copilot embeddings API, VS Code, GitHub policy, and this plugin.

## Decision

**Partial.** A `sessions/` **whitelist is viable today through client-side post-filtering** on branch `fix/session-path-whitelist`. A folder **blacklist is not exposed by this plugin today**. Neither whitelist nor blacklist can be expressed through `/embeddings/code/search` tool parameters or `scoping_query` for this repository.

| Requirement | Verdict | Where it happens | Important limit |
|---|---|---|---|
| Search the private repository | **Yes** | API: `scoping_query: repo:lkonga/ocsearchv2` | Requires a token that can access the repo |
| Return only `sessions/` hits | **Yes, client-side** | Plugin branch: `path=["sessions"]` then `filterResultsByPathPrefix` | API still searches/ranks the whole index; filtering applies only to returned candidates |
| Include folders through API scope | **No** | Not supported by the observed embeddings endpoint | Adding `path:sessions` returns 404 |
| Exclude folders through API scope | **No** | Not supported by the observed embeddings endpoint | `notPath:` also returns 404 |
| Exclude folders through current plugin params | **No** | No `notPath`/exclude parameter exists | Requires a plugin enhancement or repository/index policy |
| Exclude content through GitHub Copilot settings | **Potential policy option, not verified as an embeddings query control** | Repository/organization Copilot content exclusion | Treat as governance/index-policy configuration, not a per-call filter; verify behavior after reindexing |
| Full include/exclude globs | **Not in this plugin path** | VS Code workspace search has client `globPatterns`; plugin has prefix include only | `path=["sessions"]`, not `path=["sessions/**"]` |

For `ocsearchv2`, the practical production answer is therefore: **repo-only semantic retrieval followed by a `sessions/` prefix whitelist in the plugin**. This gives session-only output, but not a session-only embeddings index or guaranteed recall within `sessions/`.

## Verified behavior

### Copilot embeddings API

Live checks on 2026-07-13 established:

| `scoping_query` | Result |
|---|---|
| `repo:lkonga/ocsearchv2` | HTTP 200; results included `sessions/ses_….md` and `INDEX.md` |
| `repo:lkonga/ocsearchv2 path:sessions` | HTTP 404 `repository not found` |
| `repo:lkonga/ocsearchv2 lang:Markdown` | HTTP 404 |
| `repo:lkonga/ocsearchv2 notPath:scripts` | HTTP 404 |
| `repo:lkonga/ocsearchv2 notLang:Python` | HTTP 404 |

The same extra-token failure was reproduced against a public repository. A request without `repo:` returned HTTP 422 with `expected repo:<nwo>`. The evidence indicates this code-search endpoint interprets everything after `repo:` as the repository name rather than accepting the richer query grammar.

**Conclusion:** for `POST /embeddings/code/search`, use exactly `repo:<owner>/<repo>`. Do not append `path:`, `lang:`, `notPath:`, `NOT`, or arbitrary search text to `scoping_query`.

### Upstream VS Code paths

These similarly named mechanisms are separate:

1. `GithubRepoSemanticSearchTool` exposes only repository and natural-language query.
2. `GithubCodeSearchService.semanticSearch()` sends `repo:${owner}/${repo}` to `POST /embeddings/code/search`.
3. `WorkspaceChunkSearchService` can apply `globPatterns.include`/`exclude` with `shouldInclude()` **after** remote results return.
4. `formatScopingQuery()` supports `path`, `notPath`, `lang`, and `notLang`, but belongs to the separate code/docs remote-search client. It is not evidence that `GithubCodeSearchService` or the embeddings endpoint accepts those operators.
5. GitHub lexical code search (`search/code`) is another path again; its qualifiers and behavior do not expand the embeddings API contract.

Relevant upstream files:

- `extensions/copilot/src/extension/tools/node/githubRepoSemanticSearchTool.tsx`
- `extensions/copilot/src/platform/remoteCodeSearch/common/githubCodeSearchService.ts`
- `extensions/copilot/src/platform/remoteCodeSearch/common/remoteCodeSearch.ts`
- `extensions/copilot/src/platform/workspaceChunkSearch/node/scenarioAutomationWorkspaceChunkSearchService.ts`
- `extensions/copilot/src/platform/remoteSearch/common/utils.ts`
- `extensions/copilot/src/platform/remoteSearch/node/codeOrDocsSearchClientImpl.ts`

### OpenCode plugin branch

Branch `fix/session-path-whitelist` contains:

- `e28c05b`: normalize trailing slashes in path filters;
- `5af1e29`: send repo-only API scope when `path` is set, then call `filterResultsByPathPrefix`;
- coercion for scalar or array path input;
- tests for path-prefix filtering.

The prefix predicate accepts an exact path or a descendant:

```text
result.path === "sessions"
or
result.path starts with "sessions/"
```

Consequently `path=["sessions"]` retains `sessions/ses_….md` and rejects `INDEX.md`, `manifest.json`, and other top-level files from the returned candidate set. `sessions/` is normalized to the same prefix. This is **prefix matching, not glob matching**.

The branch tests passed: `24 pass, 0 fail`. The displayed raw count is taken after path filtering, before the existing dedupe/quality filter.

## Production procedure

### Operators

1. **Verify access and index readiness.** Ensure `gh auth status` shows an account with access to private `lkonga/ocsearchv2`. A repo-only embeddings request must succeed before path filtering can help.
2. **Deploy a plugin revision containing `5af1e29`.** At ticket-writing time this is local branch `fix/session-path-whitelist`, two commits ahead of `main` and not pushed to `origin`; deploy from this checkout or push the branch first. Merely passing `path` to an older deployed plugin does not provide this workaround.
3. **Use the private-repo token path.** In environments intended to use only `gh auth token`, set `GITHUBREPO_GH_ONLY=1`. Otherwise ensure the plugin's normal Copilot/`gh` token selection can read the repository.
4. **Invoke the tool with a literal prefix:**

   ```text
   githubrepo(
     repo="lkonga/ocsearchv2",
     query="<semantic description of the session>",
     path=["sessions"]
   )
   ```

   Do **not** use `path=["sessions/**"]`; the plugin filter is not a glob engine.
   Do not add `lang` expecting a second filter: the branch suppresses `lang` when `path` is present, while `lang` without `path` is still sent to the API and was observed to 404.
5. **Validate every returned path.** Expected hits begin with `sessions/`. A hit such as `INDEX.md`, `README.md`, or `manifest.json` means the deployed plugin does not contain the client filter or the caller omitted `path`.
6. **Drill down locally.** Extract the `ses_…` ID from the Markdown filename and use the established local session fetch/export flow for the full session. Embeddings results are discovery snippets, not the source of truth.
7. **Keep a fallback.** If repo-only search returns 404, fix repository authorization/indexing rather than adding path syntax. If no session survives the filter, retry with a clearer semantic query or local session search; whole-repo top-N ranking may have crowded out relevant `sessions/` candidates.

### Verification check

Run at least one query whose whole-repo result is known to include both a session and a top-level index file, then compare:

1. without `path`: mixed repository paths may appear;
2. with `path=["sessions"]`: every emitted result must begin `sessions/`;
3. with `path=["sessions/"]`: behavior must match step 2;
4. From `/home/lkonga/codes/opencode-plugins/opencode-githubrepo`, run `bun test`: expect the branch test suite to pass. One current isolated `buildScopingQuery` test still asserts the unsupported `path:` serialization; replace it as described below rather than treating it as API validation.

### Optional repository policy

If operators want non-session content omitted as a durable Copilot governance rule, configure GitHub Copilot content exclusion for the unwanted paths at repository/organization level, subject to the plan and policy controls available to the organization. Then allow policy propagation/reindexing and repeat the repo-only search checks.

Do not treat this as a substitute for the client whitelist until a live test proves that the exclusion changes `/embeddings/code/search` results for `lkonga/ocsearchv2`. Content exclusion is not a `githubrepo` request parameter, cannot be changed per query, and the direct content-exclusion endpoint probes performed during this analysis returned 404.

## Optional implementer procedure

### Finish and document whitelist support

1. Keep the embeddings request repo-only for all code-search calls.
2. Keep path normalization and post-filtering from `fix/session-path-whitelist`.
3. Replace the misleading isolated test that expects `buildScopingQuery(..., ["sessions"])` to produce `path:sessions` with an execution/request test proving the API body is repo-only and output paths are filtered.
4. Add explicit tests for `sessions`, `sessions/`, exact-file prefixes, and zero surviving results.
5. Document that client filtering occurs after GitHub's top-N retrieval and may reduce recall.
6. Do not silently send `lang:` when no path is supplied: current `buildScopingQuery` appends it and live evidence shows it also 404s. Make code-search API scope unconditionally repo-only and post-filter language, or remove/document the unsupported parameter.

### Add blacklist support, if required

1. Add an optional `notPath: string[]` (or clearly named `excludePath`) tool parameter.
2. Normalize it with the same slash rules as `path`.
3. Apply include prefixes first and exclude prefixes second to the returned candidates.
4. Use boundary-safe matching (`p === prefix || p.startsWith(prefix + "/")`) so excluding `sessions-old` does not exclude `sessions-old-copy`.
5. Add tests for include-only, exclude-only, combined include/exclude, exact file, trailing slash, and empty result cases.
6. Never serialize exclusions as `notPath:` or `NOT (path:…)` in the embeddings `scoping_query`.

Full glob semantics are unnecessary for the current `sessions/` use case. Add a glob matcher only if operators actually require patterns beyond path prefixes; do not copy VS Code's `globPatterns` API merely because it exists upstream.

## Explicit non-capabilities

- Tool parameters alone cannot create a session-only Copilot embeddings index; the observed API indexes/searches at repository scope and exposes no folder-scoping parameter.
- `path`, `lang`, `notPath`, and `NOT` cannot scope the observed embeddings API request for `lkonga/ocsearchv2`.
- Current `githubrepo` has no blacklist/exclude argument.
- Current branch does not provide full glob semantics.
- Client filtering cannot recover relevant session hits that were absent from GitHub's top-N whole-repo response.
- GitHub Content exclusion is policy/index composition, not a per-search API filter, and its effect on this endpoint remains to be verified live.
- SearchSkill/docs-search parsing and `parseGithubCodeSearchResponse` glob handling do not automatically apply to the OpenCode plugin; this plugin calls the embeddings endpoint directly and must implement its own post-filter.

## Acceptance criteria

These describe the production end state; items requiring branch deployment or follow-up plugin/policy work remain open by design.

- [ ] Production plugin sends exactly `repo:lkonga/ocsearchv2` as embeddings scope.
- [ ] `path=["sessions"]` emits only `sessions/…` paths.
- [ ] Operator docs use `sessions`, not `sessions/**`.
- [ ] Docs state that filtering is post-retrieval and can reduce recall.
- [ ] Docs state that blacklist is unavailable until a client `notPath`/exclude filter is implemented.
- [ ] No implementation claims that Docs Search/SearchSkill glob parsing changes embeddings API behavior.
- [ ] Any GitHub Content exclusion claim is validated against live repo-only embeddings results after policy propagation.

## Sources and evidence

- Local plugin: `index.ts` (`buildScopingQuery`, `filterResultsByPathPrefix`, tool execution) and `githubrepo.test.ts`.
- Local history: `e28c05b`, `5af1e29` on `fix/session-path-whitelist`.
- Live API checks summarized above: repo-only 200; `path`, `lang`, `notPath`, and `notLang` additions 404.
- Upstream VS Code source files listed in “Upstream VS Code paths.”

No GitHub issue or code commit is part of this analysis ticket.
