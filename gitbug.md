# git-bug — swarm channel (handoff to meta)

Draft doctrine + lexicon + verified mechanics, for meta to adjust and land in root AGENTS.md (Documented Practices). Delete this file once landed.

## Doctrine blurb (draft)

> **git-bug (swarm channel)** — Internal coordination lives in the git-bug store on the monorepo (`plurnk-service`) — always, even when the issue concerns a leaf or standalone repo. GitHub Issues are only for external bug reports and PR affairs. Act as your roster handle, never as another. Write through `bin/bug`, never the raw binary. Session start: `git bug pull`; after any write: `git bug push`. One bug = one actionable thread; title is a conventional-commit subject (one line, ≤80 chars); label with the handle of the lane that must act; relationships via trailers; comment, don't edit; close when done. Always pass explicit bug ids — never `select`.

## Roster (identities to create in the monorepo store)

Scope column is meta's to correct — drafted by core from conversation.

| Handle | Identity email | Scope |
|---|---|---|
| owner | wikitopian@pm.me | steers, decisions, OTP |
| meta | wikitopian+meta@pm.me | doctrine, coordination, leaf tooling |
| core | wikitopian+core@pm.me | engine (plurnk-core) |
| grammar | wikitopian+grammar@pm.me | GBNF library |
| execs | wikitopian+execs@pm.me | exec surface (execs-mcp, execs-wasm) |
| schemes | wikitopian+schemes@pm.me | scheme handlers |
| mimes | wikitopian+mimes@pm.me | plurnk-mimetypes-* leaves |
| providers | wikitopian+providers@pm.me | plurnk-providers-* leaves |
| clients | wikitopian+clients@pm.me | agui, plurnk.nvim |
| bench | wikitopian+bench@pm.me | benchmarks, plurnk-bench |

## Lexicon

### Title grammar

`^(feat|fix|chore|refactor|docs|test|build|perf|ci|revert|epic)(\([a-z0-9-]+\))?: \S` — one line, ≤80 chars total. The commit-subject lexicon, identical; scope optional, free-form lowercase.

### Labels

Exactly one bare roster handle per bug = the lane that must act. Nothing else. (Optional later: wrapper-derived `type:<type>` mirror of the title prefix for structured queries — wrapper is the only writer, so no drift.)

### Relationship trailers

In the opening message or any later comment; last-writer-wins per key; ids must resolve to existing bugs.

- `Blocked-By: <id>` — the only stated direction; `Blocks:` is forbidden and derived by inversion
- `Part-Of: <id>` — parent; target is an `epic(…):` bug
- `Duplicate-Of: <id>` — state it, then close the duplicate

## Enforcement (substrate facts + meta build items)

Substrate: git-bug has no hooks, no label policy, no write-time validation — multiline titles are silently fused, oversize titles stored verbatim; `git bug push` runs in-process (go-git), so git pre-push hooks never fire; `git bug label` policy config is upstream future work. Enforcement is ours, two layers, fail-hard:

- [ ] `bin/bug` wrapper (Node, plurnk-meta tooling home): validate-then-delegate to `git-bug`. Intercepts `bug new` and `bug title edit` → title grammar + single line + ≤80; validates trailer grammar and id resolution in `-m` messages; all other subcommands pass through untouched. Violation = loud reject, non-zero exit — never silent mangling.
- [ ] Linter sweep: walk `git bug bug -f json` + `git bug bug show <id> -f json`; invariants: title grammar, exactly one lane label, trailers resolve, no `Blocked-By` cycles. Runs doctrinally before push and in meta's periodic sweep.

## Verified mechanics (v0.10.1, smoke-tested 2026-07-12)

- Binary: `~/.local/bin/git-bug` v0.10.1, sha256 `3ba2f8b41e526fef1b6e825d5030823be65bb6521a287b1139bd609fed0d54a1` (pin: every box installs this digest; upstream ships no checksum file)
- Create identity: `git bug user new -n <handle> -e <email> --non-interactive`
- Active identity = repo-local git config `git-bug.identity`; switch with `git bug user adopt <id>`. `git -c git-bug.identity=…` does NOT override (git-bug reads the config file, not `GIT_CONFIG_PARAMETERS`) — adopt immediately before writing; concurrent cross-lane writes in one checkout can misattribute
- File: `git bug bug new -t "…" -m "…" --non-interactive`
- Comment: `git bug bug comment new <id> -m "…" --non-interactive`
- Label: `git bug bug label new <id> <handle>` / `git bug bug label rm <id> <handle>`
- Close/reopen: `git bug bug status close <id>` / `git bug bug status open <id>`
- List/query: `git bug bug status:open label:core sort:edit-desc` (`-f json` for machine reads; quote colon labels: `label:"type:fix"`)
- Sync: `git bug pull` / `git bug push` — rides origin as `refs/bugs/*` + `refs/identities/*`, invisible in the GitHub UI; fresh clones must `git bug pull` (clone does not fetch these refs)
- Human UIs: `git bug termui`, `git bug webui`

## Remaining to land (meta's call on order)

- [ ] Create the 10 roster identities in the monorepo store; `git bug push`
- [ ] Build `bin/bug` wrapper + linter sweep (specs above)
- [ ] Land the doctrine blurb + roster table + lexicon in root AGENTS.md
- [ ] Hand the blurb to standalone-repo lanes (bench, execs, clients, grammar) — their AGENTS.md points at the monorepo store; leaves get nothing
