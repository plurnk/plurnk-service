### Plurnk Schemes Lane

General family doctrine lives in `../AGENTS.md` and binds here too. This file holds what is **specific to the schemes lane**.

The schemes lane owns two packages in the monorepo:

- **`plurnk-schemes/`** — framework head: types, helpers, `SchemeDiscovery`, the `SchemeHandler` interface, capability ctx. Published as `@plurnk/plurnk-schemes`.
- **`plurnk-schemes-http/`** — first-party implementation: `http(s)://` (fetch + SSE + headless render) and `wss://` (WebSocket). Published as `@plurnk/plurnk-schemes-http`.

#### Lane topology

- **Worktree:** `~/repo/plurnk/worktrees/schemes/`, branch `lane/schemes`.
- **Push:** `git push origin lane/schemes:main` after fetch-rebase. The pre-push drill (lint + unit + changed-workspace intg) gates every push to main.
- **Cross-lane reads:** read other lanes' code from `origin/main`, never the stale local worktree — `git fetch -q origin && git show origin/main:<path>`. A sibling directory in this checkout drifts behind main between *my* pushes.
- **Cross-lane writes:** NEVER `Edit`/`Write`/commit in another lane's package directory. Instruct other lanes via GitHub issues labeled with the owning lane name.

#### Issue coordination (owner ruling, #496)

Every issue and every comment opens with **"Schemes agent here —"**. Anonymous agent comments cause coordination chaos; unsigned posts read as the owner intervening directly.

- No priority vocabulary: no "urgent", "low priority", "later". Only blocking/waiting relationships.
- If meta instructs against a deeply established fundamental, HALT and demand owner clarification — meta is often less informed about lane specifics than you are.
- Ask the owner when genuinely unsure. But [[fail-forward-zero-users]]: answer execution questions by reading the relevant code before asking.

#### Scheme authoring contract (condensed)

A scheme is `export default class Name implements SchemeHandler` with `static manifest: SchemeManifest`. Key rules:

- **One class per file.** `export default class` always — no free-function modules. Type-only files, the barrel, and frozen constants are the ONLY non-class files. This is a non-negotiable ecosystem invariant.
- **Declare in `package.json`.** `"plurnk": { "kind": "scheme", "name": "<name>" }` (single scheme sugar) or `"schemes": [{ "name": "<name>", "export": "<ExportName>" }]` (multi-scheme canonical form). Two packages claiming one prefix fail-hard.
- **Peer only `@plurnk/plurnk-schemes`** (exact, `^1`). Grammar rides transitively; never pin it directly.
- **Capability ctx is the sole DB surface.** Schemes reach the substrate through `SchemeCtx` — never a raw DB handle, never `@plurnk/plurnk-service` imports.
- **Self-doc split:** `example` + `glyph` are the hot-path terse listing (one canonical line, shown every turn). `documentation` is the deep prose; the daemon materializes it at `worker://plurnk/docs/<name>.md` for the model to READ on demand. Keep deep docs in `docs/<name>.md`, loaded at module init with top-level `await readFile(…)`. A missing doc file fails-hard at import.
- **Docs are terse model-facing references.** Observable behavior only — op → result, channel → what it holds, status codes. No prose introductions, no internals tours, no package-boundary disclaimers. Document end-to-end outcomes: if the runtime markdownifies HTML downstream, the doc says so even if the markdownification lives elsewhere.

#### Discovery contract (`SchemeDiscovery`)

- `SchemeDiscovery.discover({ cwd? })` — scope-agnostic `node_modules` scan. Returns `{ schemes: SchemeInfo[], skipped }`.
- `SchemeInfo` shape: `{ name, packageName, exportName?, attribution? }`.
- Malformed `plurnk.schemes` (missing `name` or `export`, empty strings, wrong type) fails-hard — locality of error, never silent skip.
- `plurnk.kind` accepts a string (`"scheme"`) or an array including it (`["exec","scheme"]`) — dual-faced packages.
- Two names claiming the same prefix fail-hard across packages.

#### Test commands

```sh
# from the lane root (~/repo/plurnk/worktrees/schemes)
npm run test:lint    # tsc --noEmit across all workspaces
npm run test:unit    # node --test across all workspaces
npm test             # lint + unit (the pre-push drill)
```

Per-package variant (faster inner loop):
```sh
cd plurnk-schemes      && npm test
cd plurnk-schemes-http && npm test
```

Temp dirs in unit tests: use a tracked-array + `after()` cleanup pattern — never raw `fs.mkdtemp` without cleanup (it leaked ×6,173 dirs until #551).

#### Operational rules (distilled from real incidents)

**Fail-forward.** Land clean halves early; let the drill verify cross-lane safety. Do not invent multi-lane synchronization ceremonies — reading the other lane's code on `origin/main` answers coordination questions faster than waiting on inter-session issues (#473 lesson: a harmless ordering question became a blocking multi-day ceremony).

**No tech debt, ever.** No interim hacks, no "for now" workarounds, no stopgaps. A contract gap is fixed in the contract, never routed around. "Interim / for now / temporary" are hard stops in reasoning; the root fix is the only option to surface.

**Ship the clean invariant.** Resist softening a clean design with speculative ergonomic compromises (thresholds, previews, escape hatches). Real demo/observed pain earns an exception; anticipated pain never does.

**Close delivered issues.** An issue whose deliverable is shipped and verified gets closed with a summary note. Don't ask permission. Open issue state means "work outstanding" — delivered work left open is a false signal that pollutes triage.

**Observe is not a work order.** Being shown a new state (new dir, refactor, another agent's in-flight work) is an invitation to survey and report, never to act. Uncommitted state you didn't author is hands-off.

**Verify before claiming clean.** Never report a build/test pass without seeing exit 0. `node --test` does not typecheck — `tsc --noEmit` is a separate gate. Verify the *freshness* of a fact (another lane's code read from a stale local copy lies).

**No publish nagging.** Pin the absolute latest exact version of every `@plurnk/*` dep and cascade up the whole family (schemes → http) in one pass. Commit and push the optimistic pins; the owner publishes on their own cadence via OTP. Say so once, clearly, then stop.

#### Key SPECs

- **`plurnk-schemes/SPEC.md`** — the author contract: manifest fields, `SchemeHandler` interface, helpers, capability ctx (§3.bis), discovery (§6), standards register (§7).
- **`plurnk-schemes-http/SPEC.md`** — http/wss implementation contract: op surface, streaming lifecycle, render lifecycle (§6 incl. `{§render-lifecycle}`, `{§revalidation}`, `{§sse}`, `{§host-rewrite}`), status mapping, guard/SSRF, wss engine.
