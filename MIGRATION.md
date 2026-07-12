# Monorepo Migration Runbook

**Status: EXECUTING — GO declared 2026-07-12.** Designed 2026-07-11 (owner + meta agent). This file is the execution contract — self-contained on purpose: any future session (post-compaction, post-death) executes from here. Decision ledger duplicated in meta-agent memory (`plurnk_monorepo_migration_plan.md`).

**GO-day rulings (2026-07-12):** all 7 proposed roster rows confirmed as proposed — jsonl, ipynb, diff, ini, dotenv, tokenizers IN; safetensors OUT. Routing: the big sister instructs daughters directly for her own consumption needs; mom handles doctrine/strategy/conflicts. GO-day recon: all repos clean+synced; 22 packages bumped during settlement (grammar 0.76.10, service 0.89.0, schemes-http 0.20.2 …); `.env.defaults` rename ALREADY DONE ecosystem-wide (§3.8 pre-completed); env-defaults floor doctrine landed in AGENTS.md. Publish freeze in effect for the window.

## 1. Settled decisions

- `plurnk-service` (the GitHub repo) becomes the platform monorepo via **npm workspaces**. Root = private meta space: root `package.json` (workspaces array in dependency order), ONE lockfile, shared devDeps (typescript), `.githooks/pre-push` = the entire CI (never GitHub Actions), root `AGENTS.md`/`SPEC.md`. No code at root.
- Current service source moves down into **`plurnk-core/`** (owner-settled dir name; the npm package stays `@plurnk/plurnk-service` — dir≠pkg is the ONE deliberate exception, encoding the org chart). All other workspace dirs = npm name minus scope (`plurnk-schemes-http/`).
- **NO npm renames anywhere.** `@plurnk/plurnk-*` frozen uniformly. `plurnk-core` never appears on npm. Client repo + `@plurnk/plurnk` fully out of scope. Bins: client keeps `plurnk`; grammar's bin key renamed `plurnk-grammar` (collision bugfix).
- **Boundary criterion (owner's):** OUT iff a third party could/would know better (vendor adapters, language grammars). Monorepo membership = default-bundle membership; bundle = `plurnk-core`'s own `dependencies`. Weight tiebreaks only within owner-domain; doctrine may override to IN, never OUT.
- **All four `-all` aggregators are deleted** (npm-deprecated, repos archived). Verified zero code consumers. `execs-batteries.test.ts` re-points at core's deps = executable bundle definition. Out-of-bundle leaves needed by tests become core devDeps.
- **Pinning:** lockstep single version for all workspaces; release script rewrites internal deps to the exact new version (published manifests stay exact-pinned; dev is pin-free via workspace auto-linking). Publish per-workspace (`npm publish -w`), bottom-up, owner OTP.
- **Registry surface unchanged**: every workspace package keeps publishing individually. Monorepo ≠ unpublishing. Rollback insurance: archived repos are archived, not deleted.
- Roles: meta agent = MOM (executes this runbook); service agent = big sister (daemon surface only).

## 2. Package disposition table (complete — every directory)

### IN — monorepo workspace + default bundle (settled)
`plurnk-service`→`plurnk-core/` · `plurnk-grammar` · `plurnk-schemes` · `plurnk-schemes-http` · `plurnk-execs` · `plurnk-execs-common` · `plurnk-execs-search` · `plurnk-execs-mcp` · `plurnk-execs-git` · `plurnk-execs-jq` · `plurnk-execs-sqlite` · `plurnk-mimetypes` · `plurnk-mimetypes-application-json` · `plurnk-mimetypes-application-xml` · `plurnk-mimetypes-application-pdf` (owner-promoted) · `plurnk-mimetypes-text-csv` · `plurnk-mimetypes-text-html` · `plurnk-mimetypes-text-markdown` (owner-confirmed) · `plurnk-mimetypes-text-plain` · `plurnk-mimetypes-embeddings` (owner-confirmed; peer→regular dep at migration) · `plurnk-providers` · `plurnk-providers-ollama` (local floor = owner-domain) · `plurnk-agui` (owner-listed; ⚠ revisit flag §6.3) · `plurnk-docs` · `plurnk-models` · `plurnk-aliases` · `gbnf` — **27 packages**

### PROPOSED IN — universal formats, need owner rubber-stamp at GO
`plurnk-mimetypes-application-jsonl` · `plurnk-mimetypes-application-ipynb` · `plurnk-mimetypes-text-diff` · `plurnk-mimetypes-text-ini` · `plurnk-mimetypes-text-dotenv` · `plurnk-mimetypes-tokenizers` (pairs with embeddings) — **6**

### DELETE — npm deprecate + archive repo (settled)
`plurnk-execs-all` · `plurnk-schemes-all` · `plurnk-mimetypes-all` · `plurnk-providers-all` — **4**

### OUT — independent repos, unchanged (settled as classes)
- Cloud vendor providers: `plurnk-providers-cloudflare` · `-google` · `-openrouter` · `-xai` (own relay/fireworks would also ride this surface — owner-explicit)
- `plurnk-execs-wasm` (wabt; speculative capability)
- `plurnk-mimetypes-application-gguf` (owner-explicit) · `plurnk-mimetypes-application-safetensors` (PROPOSED out, symmetry with gguf)
- All 28 `plurnk-mimetypes-grammar-*` (bash c cpp css dart elixir fsharp fsharp-signature go haskell java javascript julia kotlin lua make ocaml odin php python ruby rust scala toml tsx typescript yaml zig)
- Community-owned text mimetypes (24): clojure cmake common-lisp csharp datalog dockerfile erlang gherkin graphql mariadb nix perl plsql postgresql prolog protobuf r redis sparql sqlite swift terraform tsql vim

### UNTOUCHED
`plurnk` (client) · `plurnk.nvim` · `plurnk-bench` (one-line re-pin post-cutover) · `benchmarks/` (specimen data, stays at `~/repo/plurnk/benchmarks/`) · `plurnk-endpoint`/`plurnk-build`/`plurnk.web` (separate projects, zero changes)

## 3. Code changes required (all verified against source 2026-07-11)

1. `plurnk-core/src/core/PluginLoader.ts:40` — `withFileTypes` + `entry.isDirectory()` skips symlinks → zero plugin discovery in workspace dev. Use `stat` (follows symlinks).
2. `plurnk-core/src/service.ts:96` + `src/server/Daemon.ts:129` — `resolve(process.cwd(), "node_modules")` breaks under hoisting. Walk up to nearest `node_modules` containing plugins; keep env override.
3. `PluginLoader.discoverPlugins` scans only `@plurnk` scope — contradicts AGENTS.md scope-agnostic + `PLURNK_PLUGINS_TRUSTED_ONLY` promise. Fix in same pass.
4. `test/intg/deps-audit.test.ts` — mock fixture references `mimetypes-all`; update.
5. `plurnk-grammar/package.json` — bin key `plurnk` → `plurnk-grammar`.
6. `plurnk-core/package.json` — embeddings peer+devDep → regular dep; delete `-all` deps; add PROPOSED-IN leaves as deps; move test-only OUT leaves to devDeps.
7. Engines: **`>=26` everywhere, no drift** (owner-settled 2026-07-11); add missing `engines` to `plurnk-docs`.
8. **`.env.example` → `.env.defaults`** ecosystem-wide (owner-settled): rename files, update all `--env-file-if-exists` script args, update the AGENTS.md doctrine line ("canonical config" clause keeps its meaning; only the misnomer dies).
9. **Build exits the inner loop:** monorepo dev/test runs TS sources directly across workspaces (symlinks resolve to realpaths outside `node_modules`, so type stripping applies — verified erasable-only syntax in core six). tsc survives ONLY inside the publish script: Node still refuses type stripping for real files under `node_modules` (nodejs/node#57215, unresolved as of Node 26), so published tarballs stay compiled JS. Mechanism for dual resolution (src in dev, dist in tarball) — conditional exports or equivalent — designed at GO. Grammar keeps antlr/gbnf codegen.

## 4. Cutover sequence (each step gates the next)

0. **GO:** owner settles §6 open items. Freeze publishes for the window. `npm ls --all` snapshot per repo.
1. **Docs first:** rewrite monorepo-root `AGENTS.md` (family model, own-folder rule → directory-scoped lanes, pin doctrine §"pin latest exact" → workspace-era rules, ripple protocol retired). Update this runbook as steps complete.
2. **History import:** per absorbed repo: clone → `git filter-repo --to-subdirectory-filter <dir>` → `git merge --allow-unrelated-histories` into plurnk-service. Scripted loop, one commit per repo.
3. **Move core:** service `src/ test/ bin/ scripts/ migrations/ package.json …` → `plurnk-core/`. Root skeleton in.
4. **Manifests:** internal deps → exact lockstep version (script); workspaces array topo-ordered; delete per-package lockfiles; per-package `.githooks` removed (root hook supersedes); root scripts chain builds/tests explicitly (npm `--workspaces` order is NOT topological).
5. **Code fixes** (§3). 
6. **Gates (all four, no partial passes):** root lint+unit+intg across all workspaces · `npm ls --all` zero invalid · `test:installation` from packed tarballs · `npm publish --dry-run` each workspace.
7. **Outside-leaf range wave — ALL ~57 leaves:** with 1.0.0 as the start version, every existing head-peer range is dead (`<1.0.0` bounds and union ranges alike exclude 1.0.0). Script rewrites every outside leaf's family-head peer to `^1`; commit+push each; owner batch-publishes. One wave, never again.
8. **Version + publish:** stamp lockstep start version; publish wave bottom-up (owner OTP); deprecate the four `-all`s with pointer messages.
9. **GitHub:** `gh issue transfer` open issues → plurnk-service; archive absorbed repos with pointer READMEs.
10. **Local FS:** remove absorbed sibling checkouts from `~/repo/plurnk/`.
11. **Post-verify:** fresh-clone onboarding drill (`git clone && npm install && npm test` — hooks self-wire via root `prepare`) · naive-install e2e of published service · model-tier smoke (foreground, attended) · bench re-pin + run.

**Point of no return = step 8 publishes.** Everything before is a git branch/worktree state, fully discardable.

## 4b. Execution notes (2026-07-12 — what the cutover actually surfaced)

1. **Stale root `node_modules`** (untracked, survived the git mv) poisoned the first install — removed.
2. **Native tree-sitter is a phantom peer**: grammars' peerOptional ranges conflict (go ^0.25 vs haskell ^0.21, no aligned versions exist) and its gyp build fails on Node 26; the binding is imported NOWHERE (web-tree-sitter is the runtime). Resolution = root `overrides` (`tree-sitter: ^0.25.0`) + `.npmrc` `omit=peer` — matching the pre-monorepo lockfiles, which never materialized it either.
3. **Grammar codegen returns as `prepare`** (antlr + types + gbnf, no tsc) — generated sources are gitignored and must exist for everything importing grammar src.
4. **Symlink blindness was in SIX places**, not one: PluginLoader, env-defaults floor, and all four family-head scanners (`dirent.isDirectory()` misses workspace symlinks). All now accept symlinks.
5. **All four family heads' `defaultPackageDirs` walked `<cwd>/node_modules`** — sparse in workspaces; all four (plus `service.ts` and `test/floor.ts`) now walk up to the nearest node_modules containing `@plurnk`.
6. **The floor self-collided**: the workspace symlinks the daemon into node_modules as its own member → double-loaded defaults → ONE-LAW crash. `collect()` now excludes the host from the member scan.
7. **`plurnk.runtimesModule` was the one loader bypassing package exports** (manifest file path `./dist/runtimes.js` via pathToFileURL). Now an export SUBPATH (`"./runtimes"`) imported by specifier, so the `plurnk-dev` condition governs it like everything else. execs-mcp converted; execs-wasm needs the same in its own repo during the wave; execs SPEC §runtimesModule updated.
8. **Commitlint lives in the operator's global hook template** — root `.githooks/commit-msg` chains it so the hooksPath flip doesn't disable it.

## 5. Verified environment facts (2026-07-11)

- npm 11.16 / node 26.3.1. npm has **NO `workspace:` protocol** (EUNSUPPORTEDPROTOCOL) — internal specs must be real versions matching local, or npm silently fetches from registry instead of linking. Lockstep + stamp script guarantees linking.
- `npm run --workspaces` execution order is not topological — root scripts chain explicitly.
- Live drift as of design date (evidence, will be stale at GO — regenerate depmap with scratchpad script): schemes/agui pin grammar 0.76.7 vs 0.76.8; mimetypes devDep grammar 0.76.6; bench pins service 0.86.1 vs 0.87.0; endpoint at grammar ^0.74/providers ^0.25.
- All packages MIT; `.githooks` committed ecosystem-wide; erasable-only TS confirmed in core six (no enum/namespace/param-properties).

## 6. Resolutions (2026-07-11 owner rulings) + remaining OPEN

**Settled:**
1. **Start version = 1.0.0.** Semver gets teeth: plugin-contract break = major, additive = minor, fix = patch.
2. **agui = IN, flag retracted.** Code-verified (`service.ts:191-201`): agui is an in-process daemon module that owns the sole listener (PLURNK_PORT) post-#364 — the daemon's interface, not a client. The AGENTS.md description was stale pre-#364 prose; fixed same day.
3. **Meta-dir exposure accepted** until the monorepo absorbs AGENTS.md. No meta git repo.
4. **No-build resolved** as §3.9: dev from sources, compile only at publish (Node's node_modules stripping restriction stands as of v26).
5. **Engines `>=26` flat; `.env.defaults` rename** — both in §3.

**Still OPEN at GO:**
1. **Rubber-stamp proposed rows:** 6 PROPOSED-IN formats (jsonl, ipynb, diff, ini, dotenv, tokenizers) + safetensors PROPOSED-OUT.
2. **Routing rule:** does the big sister retain direct-instruct authority over daughters for the daemon's own consumption needs, or does cross-family traffic route through mom?

## 7. Plugin versioning contract (meta agent owns this)

- Cutover stamps **1.0.0 lockstep** across all workspaces; internal deps exact, script-stamped, forever.
- **Outside leaves peer on their family head with `^1`** — one range, valid until a deliberate platform major. First-party outside leaves version themselves independently; they republish only when they change.
- **The head packages ARE the compat contract carriers.** Each family head's SPEC must declare the semver-protected surface: registration API, `plurnk` manifest shape, teach format. A breaking change to that surface = platform major (2.0.0) = an explicit, rare, announced ecosystem migration event.
- Third-party plugin authors get the same deal: peer `^1`, `plurnk.kind` manifest, discovery does the rest.
- Bundle membership (core's deps) is orthogonal to versioning — in-bundle leaves ride lockstep; out-of-bundle leaves ride `^1`.

## 8. Post-migration follow-ons (owner: "remember so they get done")

1. **Scaffolder/generator per plugin family** — `npm create @plurnk/mimetype`-style (or template repos): manifest, peer range `^1`, `.githooks`, test skeleton, `.env.defaults`. The third-party surface is aspirational until this exists.
2. **Endpoint adoption pass** — `plurnk-endpoint` sits at grammar `^0.74` / providers `^0.25`; bring to 1.x after cutover.
3. **Conditional-exports mechanism** for §3.9 dual resolution — design and verify at GO, before the publish wave.
