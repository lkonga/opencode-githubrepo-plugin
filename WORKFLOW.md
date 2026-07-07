# githubrepo — what to do when you change it

## Plugin-only (this repo) — **no `build-opencode`**

| You changed | Do this | Version string in TUI |
|-------------|---------|------------------------|
| `index.ts`, `tui.ts`, README | **Restart `oc`** (or new session) | **Unchanged** — still `1.17.x-dev-patched-…` from **fork binary** |
| Smoke test | Same 3-repo `githubrepo` prompt | — |

The splash version is **`~/.opencode/bin/opencode-real`** (opencode-patches build), **not** this plugin.  
githubrepo is **`file://…/opencode-githubrepo`** in `opencode.jsonc` — loaded at runtime.

**Checkpoint:** `git tag -l 'githubrepo-known-good*'` → `git checkout <tag>` + restart `oc`.

## Fork binary (only when you change opencode-patches / upstream)

```bash
cd ~/codes/opencode-patches
# merge fix/compaction-… or your branch first if needed
build-opencode --no-update   # or your usual flags; githubrepo is NOT a patch anymore
oc --version                 # hash suffix may change; still *-dev-patched-*
```

githubrepo is **not** in `patch-registry` / `build-opencode` — deleting `githubrepo.source.*` does **not** require a rebuild for the tool.

## Patches repo cleanup (done)

Orphan `githubrepo.source.*` removed on `opencode-patches` — runtime unchanged if you don’t rebuild.