# Configuring plurnk-service

Agent guide. Read this, then generate a `~/.plurnk/.env` fit to the user's box and intent. `.env.example` is the terse machine floor — the authoritative flag list and defaults; this is its reasoning layer. Every claimed coupling below is enforced by a `test/intg` check, so it is current with the installed version.

## Install

```
npm install -g @plurnk/plurnk-service
plurnk-service start          # `migrate` first if the DB is uninitialized
```

First run creates `~/.plurnk/`: `.env` (yours, seeded once with a model picker — **edit this**), `AGENTS.md` (the operating policy, yours), `.env.example` + `INSTALL.md` (package-owned references, **refreshed every boot** — never edit them). No model ships active; a fresh daemon runs until `PLURNK_MODEL` is set.

Optional vector search: `npm i @plurnk/plurnk-mimetypes-embeddings` (heavy native deps). Absent → `~query` degrades to FTS keyword ranking.

## The cascade (where a value actually comes from)

Lowest precedence first; the last writer wins:

1. **package `.env.example`** — the true floor, evolves with the installed version.
2. **`~/.plurnk/.env.example`** — the readable legend, refreshed from the package each boot (a reference, not a place to edit).
3. **`~/.plurnk/.env`** — the user's home config, seeded once, theirs to keep. **Write generated config here.**
4. **`./.env`** — per-project, current working directory.
5. **`--env-file=<path>` / `--config=<path>`** — explicit layers.
6. **shell environment** — beats every file.
7. **`--<flag>` CLI args** — top layer, overrides all.

CLI flags are the **1:1 mirror** of the env vars: strip `PLURNK_`, lowercase, `_`→`-`. `PLURNK_SERVICE_MAX_TURNS` ↔ `--service-max-turns`; `PLURNK_MODEL` ↔ `--model`. The flag surface and `--help` are generated from `.env.example`, so a var and its flag never diverge. Feature-flag bools are `=== "1"` exactly (never `"true"`); `~/` expands to home.

## The prefix law (who owns a flag)

The prefix is the **owning package**: `PLURNK_SERVICE_*` (this daemon), `PLURNK_PROVIDERS_*`, `PLURNK_MIMETYPES_*`, `PLURNK_EXECS_*`, `PLURNK_SCHEMES_HTTP_*`, `PLURNK_CLIENT_*` (the CLI). **Bare `PLURNK_*` is reserved** for the front-door + cross-package set no single package owns: `PLURNK_MODEL[_*]`, `PLURNK_BASEURL_*`, `PLURNK_HOST`/`PLURNK_PORT`/`PLURNK_WS` (the connection rendezvous), and `PLURNK_PLUGINS_TRUSTED_ONLY` (the cross-family plugin gate). Vendor keys (`OPENAI_API_KEY`, `FIREWORKS_API_KEY`…) are vendor conventions — untouched.

A bare flag is a signal: more than one component depends on it. A prefixed one is single-owner. When a flag is `REQUIRED`, an unset or old-named value **fails the boot loudly** naming the var — never a silent default.

## Couplings (the edges an agent gets wrong)

These are relationships *between* flags. Set them as a unit.

- **The window partition is exact.** `promptBudget = min(PLURNK_SERVICE_CTX, real window) − REASONING − ASSISTANT − SAFETY`; `REASONING + ASSISTANT` is the per-call `max_tokens`. Shipped invariant: any window ≥ 77Ki partitions to **exactly 65536** prompt tokens (`78848 − 4096 − 8192 − 1024`). Reserves exceeding the window fail the boot. *(Pinned: `Engine.budget` / `shipped-defaults`.)*
- **Reasoning capacity is one number in three places.** `PLURNK_SERVICE_REASONING` (the partition's reserve) **must equal** `PLURNK_PROVIDERS_THINKING_CAPACITY` (the provider's thinking cap) **must equal** the serving box's `--reasoning-budget` launch flag. llama-server ignores per-request numeric budgets, so only the launch flag clamps it; a mismatch makes the reserve fiction. The daemon warns at boot when thinking is on. *(Pinned: `shipped-defaults` asserts the first equality.)*
- **Grammar rails ship on, gated on the provider's claim (#336).** A backend that doesn't enforce grammars drops it cleanly — the daemon boots with a notice, unconstrained on that alias. A backend that CLAIMS enforcement (`constrainsOutput`) is **verified end-to-end at boot** and fails hard if it returns unconstrained output. Daemon-global — not alias-scoped (one backend per daemon). For a known llama-server alias, pin `PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1` — it transports the grammar deterministically instead of probing `/v1/models` (a probe race once silently disabled the rails). *(Pinned: `grammar-enforcement-verify`.)*
- **A think-trained model must think somewhere.** `PLURNK_PROVIDERS_THINKING=off` reroutes a reasoning model's thought into the grammar's legal free zone as prose. Keep it `on` with a capacity; providers auto-clamp thinking on in-band grammar backends (fireworks), so one setting is right everywhere.

## Profiles (examples, not a decision tree — adapt to the real box)

- **Local GPU (llama-server).** `PLURNK_MODEL_local="openai/<name>"`, `OPENAI_BASE_URL=http://127.0.0.1:<port>`, `PLURNK_MODEL=local`, `PLURNK_PROVIDERS_LLAMA_SERVER_local=1`, thinking `on`/`4096` **with the box launched `--reasoning-budget 4096`**. Full rails, exact tokenization.
- **Cloud, bring-your-own-key.** `PLURNK_MODEL_cloud="openrouter/<model>"`, `OPENROUTER_API_KEY=…`, `PLURNK_MODEL=cloud`. No `LLAMA_SERVER` pin (not llama-server); a `response_format`-grammar backend auto-clamps thinking to none.
- **plurnk.ai endpoint.** `PLURNK_MODEL_plurnk="plurnk/plurnk"`, `PLURNK_API_KEY=…`, `PLURNK_MODEL=plurnk`.
- **Headless / CI / constrained container.** A CPU-only box should NOT disable semantic search — it should point derivation at a real embedder: `PLURNK_MIMETYPES_EMBED_BASE_URL` (any OpenAI-compatible `/v1/embeddings` — a host GPU turns a CPU-hours corpus grind into seconds). Weak hardware is the target workload, not a reason to shed capability; `PLURNK_SERVICE_EMBED_DISABLE=1` exists for test lanes that deterministically assert non-semantic behavior, nothing else. Consider `PLURNK_SERVICE_MAX_TURNS=<n>` as a cost cap, `PLURNK_SERVICE_GIT_ALLOWED=0` to lock out git in a sandbox.

## Flag sections (breakdown of `.env.example`)

Each mirrors a `# --- section ---` in the floor; consult the floor for exact defaults.

- **Storage** — `PLURNK_SERVICE_DB_PATH`, and the optional `PLURNK_SERVICE_SQLITE_*` passthroughs (sqlrite already sets a safe WAL posture; tune only for a hot/large DB).
- **Daemon transport** — bare `PLURNK_HOST`/`PLURNK_PORT` (the daemon binds); bare `PLURNK_WS` is the client's dial string (the daemon ignores it).
- **Model aliases** — bare `PLURNK_MODEL` selects the active provider; `PLURNK_MODEL_<alias>` defines one; `PLURNK_BASEURL_<alias>` overrides its endpoint. The front door — keep these bare and short.
- **Loop control / Engine rails** — `PLURNK_SERVICE_MAX_TURNS` (−1 = uncapped), `_MAX_COMMANDS`, `_MAX_STRIKES`, `_MIN_CYCLES`, `_MAX_CYCLE_PERIOD`, `_RPC_TIMEOUT`, `_LOOP_TIMEOUT`, `_PROPOSAL_TIMEOUT_MS`, `_EXEC_WAIT_MS`, `_EXEC_KILL_GRACE_MS`, `_SESSION_RUNS_MAX_ACTIVE`. Guardrails; the shipped values are sane.
- **Git** — `PLURNK_SERVICE_GIT_ALLOWED` (0 = hard sandbox lockout), `_GIT_AUTO`.
- **Packet / reference docs** — `PLURNK_SERVICE_FILES_ITEMS` (turn-1 file catalog cap), `_PROMPT_PREVIEW_CHARS`, `_DOCS_EXCLUDE`, `_PACKET_INJECT` (operator markdown section), `_POLICY`/`_PROJECT`/`_REQUIREMENTS` (policy + footer overrides; unset = the seeded/packaged defaults), `_MD_<alias>` (inject a markdown doc as a turn-0 entry).
- **Providers** — `PLURNK_PROVIDERS_THINKING`/`_THINKING_CAPACITY`, `_TEMPERATURE`, `_REPEAT_PENALTY`, `_FETCH_TIMEOUT`, `_RETRY_ATTEMPTS`/`_RETRY_DELAY`, `_PROBE_ATTEMPTS`/`_PROBE_DELAY`, `_GBNF` (grammar variant), `_LLAMA_SERVER_<alias>`, `_CONTEXT_SIZE`, `_GBNF_DEBUG`. Alias-scopable: any knob takes a `_<alias>` suffix that wins over the bare fallback.
- **The window partition** — `PLURNK_SERVICE_CTX`/`_REASONING`/`_ASSISTANT`/`_SAFETY` (see Couplings).
- **Plugins** — bare `PLURNK_PLUGINS_TRUSTED_ONLY` (0/unset = load all installed; a value = `@plurnk/*` plus an allowlist).
- **Semantic search** — `PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS`/`_CHUNK_OVERLAP` (service-side chunking), `PLURNK_SERVICE_EMBED_DISABLE` (FTS-only), `PLURNK_MIMETYPES_EMBED_WORKERS` (the embedder's pool — mimetypes-owned).
- **Schemes: http** — `PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT`/`_SALVAGE_MIN_BODY_CHARS`/`_IDLE_TIMEOUT` (required on the HTML render path), optional Playwright/Chromium knobs.
- **Execs** — `PLURNK_EXECS_<runtime>=0` disables a runtime; `PLURNK_EXECS_MCP_<server>` bridges an MCP server; `PLURNK_EXECS_SEARCH_SEARXNG_URL` enables web search (unset = search off).

The client's own knobs live under `PLURNK_CLIENT_*` (`--session`, `--run`, `--yolo`, `--json`…) — see `plurnk --help`.
