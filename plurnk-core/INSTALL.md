# Configuring plurnk-service

Operator guide. Put machine-specific choices in `~/.plurnk/.env`. Each installed package's `.env.defaults` is the authoritative list and floor for the knobs that package owns; the daemon assembles those files into the read-only `~/.plurnk/.env.defaults` catalog on every boot.

## Install

```
npm install -g @plurnk/plurnk-service
plurnk-service migrate        # apply the disposable version-1 schema baseline
plurnk-service start
```

First start creates `~/.plurnk/`: `.env` (yours, seeded once with a model picker — **edit this**), `AGENTS.md` (the operating policy, yours), `.env.defaults` + `INSTALL.md` (package-owned references, **refreshed every boot** — never edit them). No model ships active; the daemon can boot without one, but model loops fail until `PLURNK_MODEL` selects a declared alias.

The default service includes local embeddings. An explicitly disabled or unavailable embedder makes `~query` fall back to FTS keyword ranking. Set `PLURNK_MIMETYPES_EMBED_BASE_URL` to use a remote OpenAI-compatible embedding endpoint instead.

## The cascade (where a value actually comes from)

Higher-priority source classes override lower ones ({§operator-config-precedence}):

| Priority | Source                                 | Role                                                                                       |
|---------:|----------------------------------------|--------------------------------------------------------------------------------------------|
|        1 | Installed packages' assembled defaults | Versioned floor; one owner per key. A collision fails boot naming both owners.             |
|        2 | `~/.plurnk/.env`                       | User configuration, seeded once and never overwritten. **Write generated config here.**    |
|        3 | `./.env`                               | Configuration for the current working directory.                                           |
|        4 | `--config=<path>`                      | One explicit service configuration file.                                                   |
|        5 | `--env-file*`                          | Repeatable explicit files; later files win. The `-if-exists` form skips absent files.       |
|        6 | Shell environment                      | Process-level operator values.                                                              |
|        7 | `--<flag>`                             | Highest-priority service CLI value.                                                         |

`~/.plurnk/.env.defaults` is the regenerated assembled catalog, not another input layer. The service CLI mirrors only the `PLURNK_*` variables declared by the service package's own `.env.defaults`: strip `PLURNK_`, lowercase, and replace `_` with `-` (`PLURNK_SERVICE_MAX_TURNS` ↔ `--service-max-turns`). Installed plugin knobs remain available through env/config files and the assembled catalog without implicitly expanding the service executable's CLI ({§operator-config-cli-flags}). Feature-flag booleans use `1`, not `true`; `~/` expands to home.

## The prefix law (who owns a flag)

Family prefixes identify the semantic owner: `PLURNK_SERVICE_*` (this daemon), `PLURNK_PROVIDERS_*`, `PLURNK_MIMETYPES_*`, `PLURNK_EXECS_*`, `PLURNK_SCHEMES_HTTP_*`, `PLURNK_AGUI_*` (the AG-UI module), and `PLURNK_CLIENT_*` (the CLI). Bare `PLURNK_*` names are reserved for front-door or cross-family concepts such as model aliases, endpoint binding, and plugin trust. Even a cross-family key has one physical reader and one `.env.defaults` owner; “shared” never means duplicate implementations. Vendor keys (`OPENAI_API_KEY`, `FIREWORKS_API_KEY`, and peers) retain their vendor conventions.

When a value is required, an unset or retired name fails boot naming the violated key rather than selecting a silent default.

## Couplings (the edges an agent gets wrong)

These are relationships *between* flags. Set them as a unit.

- **Provider capacity and PLURNK pressure are separate.** Providers report
  physical context and response capacity. Core derives the natural input
  budget from those facts. Optional `PLURNK_SERVICE_PROMPT_BUDGET_<alias>`
  only tightens the model-facing gauge and grinder; it is never sent to the
  provider and never changes generation settings.
- **Reasoning capacity is request-scoped on llama-server.**
  `PLURNK_PROVIDERS_REASONING_RESERVE_<alias>` is the adaptive cumulative
  response allowance. An explicit `PLURNK_PROVIDERS_REASONING_BUDGET_<alias>`
  may tighten but cannot exceed it. The provider sends the allowance on every
  request; no serving-box flag synchronization is required.
- **Local GBNF is optional.** The PLURNK language is always parsed normally.
  Local llama-server users may set `PLURNK_PROVIDERS_GBNF_<alias>`; transport
  and enforcement are verified at boot. Cloud and endpoint-managed aliases
  leave it unset. A configured PLURNK rail requires reasoning `adaptive` or
  `on`; pairing it with `off` is invalid. Pin
  `PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1` only when a llama-server cannot be
  fingerprinted reliably.
- **A reasoning model must reason somewhere.**
  `PLURNK_PROVIDERS_REASONING_<alias>` selects `off`, `adaptive`, or `on`.
  An explicit `on` also requires a positive provider reasoning budget.

## Profiles (examples, not a decision tree — adapt to the real box)

- **Local GPU (llama-server).** `PLURNK_MODEL_local="openai/<name>"`, `OPENAI_BASE_URL=http://127.0.0.1:<port>`, `PLURNK_MODEL=local`, `PLURNK_PROVIDERS_GBNF_local=plurnk.gbnf`. The provider detects llama-server, verifies its GBNF transport, and derives a request-scoped reasoning allowance from the detected window. Add `PLURNK_PROVIDERS_LLAMA_SERVER_local=1` only when the endpoint cannot be fingerprinted reliably.
- **Cloud, bring-your-own-key.** `PLURNK_MODEL_cloud="openrouter/<model>"`, `OPENROUTER_API_KEY=…`, `PLURNK_MODEL=cloud`. No local GBNF or `LLAMA_SERVER` pin.
- **plurnk.ai endpoint.** `PLURNK_MODEL_plurnk="plurnk/plurnk"`, `PLURNK_API_KEY=…`, `PLURNK_MODEL=plurnk`.
- **Headless / CI / constrained container.** A CPU-only box should NOT disable semantic search — it should point derivation at a real embedder: `PLURNK_MIMETYPES_EMBED_BASE_URL` (any OpenAI-compatible `/v1/embeddings` — a host GPU turns a CPU-hours corpus grind into seconds). Weak hardware is the target workload, not a reason to shed capability; `PLURNK_SERVICE_EMBED_DISABLE=1` exists for test lanes that deterministically assert non-semantic behavior, nothing else. Consider `PLURNK_SERVICE_MAX_TURNS=<n>` as a cost cap, `PLURNK_SERVICE_GIT_ALLOWED=0` to lock out git in a sandbox.

## Flag sections (breakdown of the service's `.env.defaults`)

Each mirrors a `# --- section ---` in the floor; consult the floor for exact defaults.

- **Storage** — `PLURNK_SERVICE_DB_PATH`, and the optional `PLURNK_SERVICE_SQLITE_*` passthroughs (sqlrite already sets a safe WAL posture; tune only for a hot/large DB).
- **Daemon transport** — bare `PLURNK_HOST`/`PLURNK_PORT`: THE client surface (the AG-UI+ listener, bound by the plurnk-agui module at boot). Production is single-listener; every first-party client rides it.
- **Model aliases** — bare `PLURNK_MODEL` selects the active provider; `PLURNK_MODEL_<alias>` defines one; `PLURNK_BASEURL_<alias>` overrides its endpoint. Optional `PLURNK_MODEL_CHILD=<alias>` selects WORK/FORK descendants; unset inherits the spawning loop's provider. The front door — keep these bare and short.
- **Loop control / engine rails** — `PLURNK_SERVICE_MAX_TURNS` (−1 = uncapped), `_MAX_COMMANDS`, `_MAX_STRIKES`, `_EMISSION_ATTEMPTS`, `_MIN_CYCLES`, `_MAX_CYCLE_PERIOD`, `_LOOP_TIMEOUT`, `_PROPOSAL_TIMEOUT_MS`, `_EXEC_HOLD`, `_EXEC_WAIT_MS`, `_EXEC_POLL_SEC`/`_TURNS`, `_EXEC_KILL_GRACE_MS`, `_WORKSPACE_WORKERS_MAX_ACTIVE`.
- **Git** — `PLURNK_SERVICE_GIT_ALLOWED` (0 = hard sandbox lockout), `_GIT_AUTO`.
- **Packet / reference docs** — `PLURNK_SERVICE_FILES_ITEMS` (turn-0 shallow file-map cap), `_PREVIEW_LINES`/`_PREVIEW_CHARS`, `_EDIT_RECEIPT_REVISION_CHARS`/`_CONTEXT_LINES`, `_BRANCH_RECEIPT_REVISION_CHARS`, `_DOCS_EXCLUDE`, `_PACKET_INJECT` (operator markdown section), `_POLICY`/`_PROJECT`/`_REQUIREMENTS` (policy + footer overrides), `_MD_<alias>` (materialized reference entry).
- **Providers** — the portable provider knobs and defaults are defined by
  `@plurnk/plurnk-providers/.env.defaults`; any provider knob may take an alias
  suffix that wins over the bare fallback.
- **Provider capacity and prompt budget** —
  `PLURNK_PROVIDERS_CONTEXT_WINDOW`/`_REASONING_RESERVE`/`_COMPLETION_RESERVE`
  describe provider capacity. `PLURNK_SERVICE_PROMPT_BUDGET` applies optional
  virtual pressure; `PLURNK_SERVICE_SAFETY` is the packing margin.
- **Plugins** — bare `PLURNK_PLUGINS_TRUSTED_ONLY` (0/unset = load all installed; a value = `@plurnk/*` plus an allowlist).
- **Semantic search** — `PLURNK_SERVICE_SEMANTIC_CHUNK_TOKENS`/`_CHUNK_OVERLAP` (service-side chunking), `PLURNK_SERVICE_EMBED_DISABLE` (FTS-only), `PLURNK_MIMETYPES_EMBED_WORKERS` (the embedder's pool — mimetypes-owned).
- **Schemes: http** — `PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT`, `_TTL_MS`, optional `# TAVILY_API_KEY=`, and `PLURNK_SCHEMES_HTTP_TAVILY_DEPTH`/`_TAVILY_TIMEOUT_MS`.
- **Execs** - `PLURNK_EXECS_<runtime>=0` disables a runtime; `PLURNK_EXECS_SEARCH_SEARXNG_URL` enables web search (unset = search off).
- **Hooks** — `PLURNK_HOOKS_COMMAND` plus JSON `PLURNK_HOOKS_ARGS` invokes one exact no-shell command for the core events selected by `PLURNK_HOOKS_EVENTS`; see `@plurnk/plurnk-hooks/README.md`.
- **Observability** — standard `OTEL_*` env ({§observability-boundary}):
  `OTEL_TRACES_EXPORTER`/`OTEL_METRICS_EXPORTER` (`otlp` or `console`; unset
  keeps the signal off), `OTEL_SERVICE_NAME` (default `plurnk-service`),
  `OTEL_SDK_DISABLED` (opt out), and the OTLP exporters' own
  `OTEL_EXPORTER_OTLP_*` settings. An unconfigured daemon never loads the OTel
  SDK. Prompts, reasoning, file bodies, URLs, secrets, and plugin payloads are
  never exported.

The client's own knobs live under `PLURNK_CLIENT_*` (`--workspace`, `--run`, `--yolo`, `--json`…) — see `plurnk --help`.
