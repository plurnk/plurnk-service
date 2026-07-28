# Configuring plurnk-service

Agent guide. Read this, then generate a `~/.plurnk/.env` fit to the user's box and intent. `.env.defaults` is the terse machine floor — the authoritative flag list and defaults (the ASSEMBLED catalog of every installed package's file lands at `~/.plurnk/.env.defaults`); this is its reasoning layer. Every claimed coupling below is enforced by a `test/intg` check, so it is current with the installed version.

## Install

```
npm install -g @plurnk/plurnk-service
plurnk-service start          # `migrate` first if the DB is uninitialized
```

First run creates `~/.plurnk/`: `.env` (yours, seeded once with a model picker — **edit this**), `AGENTS.md` (the operating policy, yours), `.env.defaults` + `INSTALL.md` (package-owned references, **refreshed every boot** — never edit them). No model ships active; a fresh daemon runs until `PLURNK_MODEL` is set.

Optional vector search: `npm i @plurnk/plurnk-mimetypes-embeddings` (heavy native deps). Absent → `~query` degrades to FTS keyword ranking.

## The cascade (where a value actually comes from)

Lowest precedence first; the last writer wins:

1. **the assembled `.env.defaults` floor** — every installed package's shipped file, one owner per key (a collision crashes boot naming both), evolves with the installed versions.
2. **`~/.plurnk/.env.defaults`** — the readable assembled legend, regenerated each boot (a reference, not a place to edit).
3. **`~/.plurnk/.env`** — the user's home config, seeded once, theirs to keep. **Write generated config here.**
4. **`./.env`** — per-project, current working directory.
5. **`--env-file=<path>` / `--config=<path>`** — explicit layers.
6. **shell environment** — beats every file.
7. **`--<flag>` CLI args** — top layer, overrides all.

CLI flags are the **1:1 mirror** of the env vars: strip `PLURNK_`, lowercase, `_`→`-`. `PLURNK_SERVICE_MAX_TURNS` ↔ `--service-max-turns`; `PLURNK_MODEL` ↔ `--model`. The flag surface and `--help` are generated from the service's `.env.defaults`, so a var and its flag never diverge. Feature-flag bools are `=== "1"` exactly (never `"true"`); `~/` expands to home.

## The prefix law (who owns a flag)

The prefix is the **owning package**: `PLURNK_SERVICE_*` (this daemon), `PLURNK_PROVIDERS_*`, `PLURNK_MIMETYPES_*`, `PLURNK_EXECS_*`, `PLURNK_SCHEMES_HTTP_*`, `PLURNK_AGUI_*` (the AG-UI module's own knobs), `PLURNK_CLIENT_*` (the CLI). **Bare `PLURNK_*` is reserved** for the front-door + cross-package set no single package owns: `PLURNK_MODEL[_*]`, `PLURNK_BASEURL_*`, `PLURNK_HOST`/`PLURNK_PORT` (the connection rendezvous), and `PLURNK_PLUGINS_TRUSTED_ONLY` (the cross-family plugin gate). Vendor keys (`OPENAI_API_KEY`, `FIREWORKS_API_KEY`…) are vendor conventions — untouched.

A bare flag is a signal: more than one component depends on it. A prefixed one is single-owner. When a flag is `REQUIRED`, an unset or old-named value **fails the boot loudly** naming the var — never a silent default.

## Couplings (the edges an agent gets wrong)

These are relationships *between* flags. Set them as a unit.

- **Provider capacity and PLURNK pressure are separate.** Providers report
  physical context and response capacity. Core derives the natural input
  budget from those facts. Optional `PLURNK_SERVICE_PROMPT_BUDGET_<alias>`
  only tightens the model-facing gauge and grinder; it is never sent to the
  provider and never changes generation settings.
- **Reasoning capacity stays coupled on llama-server.**
  `PLURNK_PROVIDERS_REASONING_BUDGET_<alias>` and
  `PLURNK_PROVIDERS_REASONING_RESERVE_<alias>` must agree with the serving
  box's `--reasoning-budget`. llama-server ignores per-request reasoning
  budgets, so the daemon warns when it cannot verify this coupling.
- **Local GBNF is optional.** The PLURNK language is always parsed normally.
  Local llama-server users may set `PLURNK_PROVIDERS_GBNF_<alias>`; transport
  and enforcement are verified at boot. Cloud and endpoint-managed aliases
  leave it unset. Pin `PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1` only when a
  llama-server cannot be fingerprinted reliably.
- **A reasoning model must reason somewhere.**
  `PLURNK_PROVIDERS_REASONING_<alias>` selects `off`, `adaptive`, or `on`.
  An explicit `on` also requires a positive provider reasoning budget.

## Profiles (examples, not a decision tree — adapt to the real box)

- **Local GPU (llama-server).** `PLURNK_MODEL_local="openai/<name>"`, `OPENAI_BASE_URL=http://127.0.0.1:<port>`, `PLURNK_MODEL=local`, `PLURNK_PROVIDERS_LLAMA_SERVER_local=1`, thinking `on`/`4096` **with the box launched `--reasoning-budget 4096`**. Full rails, exact tokenization.
- **Cloud, bring-your-own-key.** `PLURNK_MODEL_cloud="openrouter/<model>"`, `OPENROUTER_API_KEY=…`, `PLURNK_MODEL=cloud`. No local GBNF or `LLAMA_SERVER` pin.
- **plurnk.ai endpoint.** `PLURNK_MODEL_plurnk="plurnk/plurnk"`, `PLURNK_API_KEY=…`, `PLURNK_MODEL=plurnk`.
- **Headless / CI / constrained container.** A CPU-only box should NOT disable semantic search — it should point derivation at a real embedder: `PLURNK_MIMETYPES_EMBED_BASE_URL` (any OpenAI-compatible `/v1/embeddings` — a host GPU turns a CPU-hours corpus grind into seconds). Weak hardware is the target workload, not a reason to shed capability; `PLURNK_SERVICE_EMBED_DISABLE=1` exists for test lanes that deterministically assert non-semantic behavior, nothing else. Consider `PLURNK_SERVICE_MAX_TURNS=<n>` as a cost cap, `PLURNK_SERVICE_GIT_ALLOWED=0` to lock out git in a sandbox.

## Flag sections (breakdown of the service's `.env.defaults`)

Each mirrors a `# --- section ---` in the floor; consult the floor for exact defaults.

- **Storage** — `PLURNK_SERVICE_DB_PATH`, and the optional `PLURNK_SERVICE_SQLITE_*` passthroughs (sqlrite already sets a safe WAL posture; tune only for a hot/large DB).
- **Daemon transport** — bare `PLURNK_HOST`/`PLURNK_PORT`: THE client surface (the AG-UI+ listener, bound by the plurnk-agui module at boot). Production is single-listener; every first-party client rides it.
- **Model aliases** — bare `PLURNK_MODEL` selects the active provider; `PLURNK_MODEL_<alias>` defines one; `PLURNK_BASEURL_<alias>` overrides its endpoint. The front door — keep these bare and short.
- **Loop control / Engine rails** — `PLURNK_SERVICE_MAX_TURNS` (−1 = uncapped), `_MAX_COMMANDS`, `_MAX_STRIKES`, `_MIN_CYCLES`, `_MAX_CYCLE_PERIOD`, `_RPC_TIMEOUT`, `_LOOP_TIMEOUT`, `_PROPOSAL_TIMEOUT_MS`, `_EXEC_WAIT_MS`, `_EXEC_KILL_GRACE_MS`, `_SESSION_RUNS_MAX_ACTIVE`. Guardrails; the shipped values are sane.
- **Git** — `PLURNK_SERVICE_GIT_ALLOWED` (0 = hard sandbox lockout), `_GIT_AUTO`.
- **Packet / reference docs** — `PLURNK_SERVICE_FILES_ITEMS` (turn-1 file catalog cap), `_PROMPT_PREVIEW_CHARS`, `_EDIT_RECEIPT_REVISION_CHARS`, `_BRANCH_RECEIPT_REVISION_CHARS`, `_DOCS_EXCLUDE`, `_PACKET_INJECT` (operator markdown section), `_POLICY`/`_PROJECT`/`_REQUIREMENTS` (policy + footer overrides; unset = the seeded/packaged defaults), `_MD_<alias>` (inject a markdown doc as a turn-0 entry).
- **Providers** — the portable provider knobs and defaults are defined by
  `@plurnk/plurnk-providers/.env.defaults`; any provider knob may take an alias
  suffix that wins over the bare fallback.
- **Provider capacity and prompt budget** —
  `PLURNK_PROVIDERS_CONTEXT_WINDOW`/`_REASONING_RESERVE`/`_COMPLETION_RESERVE`
  describe provider capacity. `PLURNK_SERVICE_PROMPT_BUDGET` applies optional
  virtual pressure; `PLURNK_SERVICE_SAFETY` is the packing margin.
- **Plugins** — bare `PLURNK_PLUGINS_TRUSTED_ONLY` (0/unset = load all installed; a value = `@plurnk/*` plus an allowlist).
- **Semantic search** — `PLURNK_SERVICE_SEMANTIC_TOP_K` (markerless result count), `_SEMANTIC_CHUNK_TOKENS`/`_CHUNK_OVERLAP` (service-side chunking), `PLURNK_SERVICE_EMBED_DISABLE` (FTS-only), `PLURNK_MIMETYPES_EMBED_WORKERS` (the embedder's pool — mimetypes-owned).
- **Schemes: http** — `PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT`/`_SALVAGE_MIN_BODY_CHARS`/`_IDLE_TIMEOUT` (required on the HTML render path), optional Playwright/Chromium knobs.
- **Execs** — `PLURNK_EXECS_<runtime>=0` disables a runtime; `PLURNK_EXECS_MCP_<server>` bridges an MCP server; `PLURNK_EXECS_SEARCH_SEARXNG_URL` enables web search (unset = search off).

The client's own knobs live under `PLURNK_CLIENT_*` (`--workspace`, `--run`, `--yolo`, `--json`…) — see `plurnk --help`.
