# Operator Assurance Map and Shared Responsibility

Plurnk is a contract-first agentic execution daemon (`@plurnk/plurnk-service`) that connects an operator's clients, model providers, local workspace files, and execution runtimes. This document maps the platform's security, privacy, and operational resilience controls to their authoritative specifications and defines the shared-responsibility boundary between the daemon and the operator.

For vulnerability disclosure, see [`SECURITY.md`](./SECURITY.md). For architecture and package ownership, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Scope and non-claims

Plurnk enforces application-level admission, capability, and provenance controls inside a single POSIX user account. It does **not** claim to be:

- **An operating-system sandbox or container runtime.** When an execution (`sh`, `python3`, `js`) or an MCP `stdio` server is admitted by policy or operator approval, it runs as a child process under the daemon's OS user and inherits that user's filesystem and network reach ({§execution-output-identity}, {§mcp-module}). Host isolation (`systemd` sandboxing, containers, VMs, firewall rules) is an operator responsibility.
- **A multi-tenant isolation boundary.** One daemon instance serves one trust domain ({§credential-authority}, {§acp-session-owner}). Concurrent ACP, Web, and `/mcp` clients attached to a workspace share that workspace's commons (`workspace:///`) and operator approval identity (`acp://operator`).
- **A compliance attestation.** This document maps technical controls to their specification tags and verification gates; it is not a SOC 2, ISO 27001, or HIPAA certification.

## Deployment data flow and trust boundaries

```mermaid
flowchart LR
    subgraph ClientBoundary["Client Boundary"]
        Client["ACP v2 · Web · /mcp · SSE Clients<br/>(CLI / Term / Browser / IDE / MCP Host)"]
    end

    subgraph DaemonBoundary["Plurnk Daemon Process (OS User Boundary)"]
        Listener["HTTP / WS Listener (:1066)<br/>{§http-host}"]
        Auth["Origin Guard & Optional OIDC Verifier<br/>{§credential-authority} {§auth-oauth}"]
        Faces["Faces: /acp · /mcp · / · /notifications<br/>{§acp-daemon-client} {§mcp-http-server} {§notifications}"]
        Coordinator["Proposal & Owner Gate<br/>{§proposal} {§session-ownership}"]
        Engine["Core Engine & SQLite WAL<br/>{§db-durability} {§content-store}"]
    end

    subgraph LocalHost["Host & Subprocess Boundary"]
        FS["Project Files & XDG State<br/>{§membership} {§host-path-layout}"]
        Exec["Local Runtimes (sh / python3 / js)<br/>{§exec-target-routing} {§exec-lifetime}"]
        MCPStdio["MCP stdio<br/>{§mcp-transports}"]
    end

    subgraph ExternalNetwork["External Network Boundary"]
        Providers["Model Providers (HTTPS)<br/>{§provider-interface}"]
        RemoteHTTP["Outbound HTTP / Remote MCP / OTel<br/>{§http-lifecycle} {§http-host-policy} {§otel-module}"]
    end

    Client <-->|"Loopback / proxy / OIDC Bearer"| Listener
    Listener --> Auth
    Listener --> Faces
    Faces --> Coordinator
    Coordinator --> Engine
    Engine <--> FS
    Coordinator -->|"Admitted host/read/pure"| Exec
    Engine --> MCPStdio
    Engine -->|"Sanitized env, API key"| Providers
    Coordinator -->|"Host policy & WebFetcher DNS guard"| RemoteHTTP
```

## Control map

Every control below is specified under its named specification tag and verified by deterministic unit or integration witnesses in the repository's drill (`npm test`, {§lint-gate}).

| Domain | Control | Specification authority | Primary operator knobs |
| --- | --- | --- | --- |
| **Listener & authentication** | Loopback bind (`127.0.0.1`), zero-password local posture (`PLURNK_AUTH_ISSUER` empty), empty `PLURNK_ACP_ALLOW_ORIGIN` / `PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN` by default, and browser same-origin CSRF, Cross-Site WebSocket Hijacking, and loopback DNS-rebinding defenses (`admitBrowserOrigin`). Optional external OIDC / OAuth 2.1 JWT verification via `jose` (`PLURNK_AUTH_ISSUER`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_AUDIENCE`, `PLURNK_AUTH_USERS` matching `sub` or `email_verified === true` `email`) with RFC 9728 `/.well-known/oauth-protected-resource` discovery. | {§http-host}, {§credential-authority}, {§acp-http-authorization}, {§auth-oauth}, {§auth-configuration} | `PLURNK_HOST`, `PLURNK_PORT`, `PLURNK_AUTH_ISSUER`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_AUDIENCE`, `PLURNK_AUTH_CALLBACK`, `PLURNK_AUTH_SCOPES`, `PLURNK_AUTH_USERS`, `PLURNK_AUTH_ALLOW_ORIGIN`, `PLURNK_ACP_ALLOW_ORIGIN`, `PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN` |
| **Extension trust** | With `PLURNK_EXTENSIONS_TRUSTED_ONLY=1` (default), only packages declared in `@plurnk/plurnk-service`'s root manifest are imported, after realpath containment within `PLURNK_SERVICE_ROOTS`. First-party `@plurnk/*` extensions and daemon modules load only from the service's package graph, while project and XDG configuration roots contribute only static definitions (`skills/`, `personas/`, `mcp.json`). | {§extension-discovery}, {§core-extension-composition} | `PLURNK_EXTENSIONS_TRUSTED_ONLY`, `PLURNK_SERVICE_ROOTS` |
| **Proposal & session-owner gate** | Effect-class gating (`PLURNK_SERVICE_EFFECT_*` → `PLURNK_SERVICE_PROPOSALS` / workspace proposal policy → standing `allow_always` / `reject_always` rules → session-owner review) plus live session-owner interaction attendance ({§question-tool}). Operator ceilings (`PLURNK_SERVICE_GIT_ALLOWED`, `PLURNK_SERVICE_FILE_CREATE_SCOPE`, `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE`, `PLURNK_SERVICE_MAX_COMMANDS`, `PLURNK_SERVICE_MAX_TURNS`) can only be narrowed, never widened by a client or model. Side-effecting operations pause on immutable proposal records until resolved by the session's owner. | {§proposal-and-model-contracts}, {§operator-config-workspace-settings}, {§proposal}, {§proposal-disposition}, {§session-ownership}, {§question-tool} | `PLURNK_SERVICE_PROPOSALS`, `PLURNK_SERVICE_EFFECT_HOST`, `PLURNK_SERVICE_EFFECT_READ`, `PLURNK_SERVICE_EFFECT_PURE`, `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS` |
| **Subprocess & environment hygiene** | Child executions (`sh`, `python3`, `js`) and MCP `stdio` servers receive a scrubbed environment (`PLURNK_*` and provider API keys stripped; `HOME` and XDG paths projected). Non-file resources materialize into `0700` scratch directories (`0710` when granting traversal to `PLURNK_EXECS_SPAWN_USER`) as `0600` files for the invocation lifetime and are bounded by loop and executor deadlines with `SIGTERM` → `SIGKILL` escalation. | {§execution-output-identity}, {§host-path-layout}, {§exec-target-routing}, {§exec-lifetime}, {§executor-policy} | `PLURNK_SERVICE_EXEC_ENV_INHERIT`, `PLURNK_SERVICE_EXEC_ENV_EXCLUDE`, `PLURNK_SERVICE_EXEC_CONCURRENCY`, `PLURNK_SERVICE_EXEC_KILL_GRACE_MS`, `PLURNK_SERVICE_EXEC_SCRATCH` |
| **Filesystem & Git boundaries** | Working-directory `.env` files are never loaded into daemon configuration. File membership tracks the working set (`(tracked ∪ include ∪ created) − exclude`); `EDIT` refuses non-members before reading or writing bytes and commits via atomic temp-file-and-rename after revision validation. Git invocations scrub `GIT_*`, disable `core.fsmonitor` and hooks (`core.hooksPath=/dev/null`), and skip repositories declaring `clean`/`process` filters. | {§operator-config-precedence}, {§membership}, {§membership-auto-add}, {§fs-write-surface}, {§file-snapshot-revision} | `PLURNK_SERVICE_GIT_ALLOWED`, `PLURNK_SERVICE_GIT_AUTO`, `PLURNK_MEMBERS_AUTO_ADD`, `PLURNK_SERVICE_FILE_CREATE_SCOPE`, `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE`, `PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES` |
| **Outbound HTTP & host policy** | `PLURNK_SCHEMES_HTTP_ENABLED=0` omits `http://`, `https://`, `ws://`, and `wss://` registration altogether. When enabled, outbound requests enforce `PLURNK_SCHEMES_HTTP_HOSTS` host policy (unset/empty for all hosts, a JSON array of exact or `*.domain` hostnames, or `[]` for no web access) on the initial URL and every redirect hop, stripped of credentials across origins. `WebFetcher` additionally resolves DNS before connect (`Guard.fetch`) and blocks loopback, RFC 1918 private, link-local, CGNAT, unique-local, multicast, and unspecified IP ranges; direct `HTTP`/`WS` operations gate network effects through `effect: "host"` proposals. | {§scheme-address}, {§http-lifecycle}, {§http-host-policy}, {§http-manifest} | `PLURNK_SCHEMES_HTTP_ENABLED`, `PLURNK_SCHEMES_HTTP_HOSTS`, `PLURNK_SCHEMES_HTTP_FETCH_TIMEOUT_MS`, `PLURNK_SCHEMES_HTTP_REDIRECTS` |
| **MCP, notifications & telemetry** | Remote MCP servers validate transport URLs, persist interactive OAuth grants encrypted (`0600`, AES-256-GCM under HKDF of the workspace `.oauth-key`) outside SQLite, and isolate failures per server; `/mcp[/<workspace>[/<session>]]` isolates `subscriptions/listen` push notifications by tenant scope. `GET /notifications` SSE enforces `admitBrowserOrigin` and `admitBearerRequest` when `PLURNK_AUTH_ISSUER` is configured, and bounds keepalives (`PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS`) and `Last-Event-ID` replay memory (`PLURNK_SERVICE_NOTIFICATIONS_BUFFER`). OpenTelemetry exports only when `OTEL_*` exporters are configured. | {§mcp-transports}, {§mcp-configuration}, {§mcp-module}, {§mcp-http-server}, {§oauth-continuation}, {§notifications}, {§http-host}, {§otel-module} | `PLURNK_SERVICE_NOTIFICATIONS_HEARTBEAT_MS`, `PLURNK_SERVICE_NOTIFICATIONS_BUFFER`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` |
| **Persistence, retention & digests** | SQLite runs in WAL mode with `STRICT` tables, foreign keys, `defensive` mode, and an exclusive `DaemonLock`. Content is interned by SHA-256 under a 100 MiB channel cap with configurable packet/response retention and incremental vacuum. Forensic digests (`plurnk-service share` / `npm run share`) copy the database consistently via `VACUUM INTO` and write unredacted diagnostic reports; review reports for sensitive content before sharing externally. | {§db-durability}, {§db-migrations}, {§content-store}, {§session-causal-admission}, {§share}, {§share-packet-names} | `PLURNK_SERVICE_STATE_ROOT`, `PLURNK_SERVICE_DB_PATH`, `PLURNK_SERVICE_SQLITE_SYNCHRONOUS`, `PLURNK_SERVICE_RETAIN_PACKET_*`, `PLURNK_SERVICE_RETAIN_RESPONSE_*`, `PLURNK_SERVICE_AUTO_VACUUM` |

## Operator hardening checklist

1. **Keep credentials in the login shell or user service manager.** Never place provider API keys in a project `.env` or repository ({§operator-config-precedence}). For the supervised systemd user unit (`plurnk.service`), use `~/.config/environment.d/*.conf` or `LoadCredential=` with `0600` permissions.
2. **Terminate TLS and authenticate before untrusted network exposure.** Keep `PLURNK_HOST=127.0.0.1` behind an authenticating TLS edge proxy (Caddy, `oauth2-proxy`, Cloudflare Access, Authelia, Tailscale Serve, or the shipped `plurnk.nginx.conf`) and/or configure an external OIDC provider (`PLURNK_AUTH_ISSUER=https://...`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_USERS`) ({§acp-http-authorization}, {§auth-configuration}).
3. **Set explicit proposal and runtime posture for unattended runs.** Review `PLURNK_SERVICE_PROPOSALS` (`review`, `accept`, `reject`), `PLURNK_SERVICE_EFFECT_HOST`, `PLURNK_EXECS_ONLY`, and `PLURNK_SCHEMES_HTTP_ENABLED` before running autonomous or scheduled workloads ({§proposal-and-model-contracts}, {§proposal-disposition}, {§executor-policy}).
4. **Constrain file creation and model membership scope when operating on sensitive hosts.** Set `PLURNK_SERVICE_FILE_CREATE_SCOPE=root` (or `none`) and `PLURNK_SERVICE_MEMBERS_MODEL_SCOPE=root` (or `none`) with `PLURNK_MEMBERS_AUTO_ADD=0` if the model should not enroll or create files outside `project_root` ({§operator-config-workspace-settings}, {§membership-auto-add}).
5. **Bound resource consumption and retention.** Configure `PLURNK_SERVICE_LOOP_TIMEOUT_MS`, `PLURNK_SERVICE_MAX_TURNS`, `PLURNK_SERVICE_EXEC_CONCURRENCY`, and `PLURNK_SERVICE_RETAIN_*` to match host disk and provider budget limits ({§operator-config-workspace-settings}, {§content-store}).
6. **Validate configuration offline before deployment.** Run `plurnk-service config check` to verify core, module, MCP, and schedule settings without opening a listener or database ({§operator-config-precedence}).

## Supply chain and release integrity

- **Single lockfile & script lockdown:** The monorepo pins a single `package-lock.json` validated under `npm ls --all`, with third-party install scripts denied by default (`allowScripts` in `package.json`, {§native-source-toolchain}).
- **Moderate-floor advisory gate:** Every package's `prepublishOnly` and the release gate enforce `npm audit --audit-level=moderate` and `npm run deps:check` ({§bundled-set}, {§package-release-contract}).
- **Clean-worktree drill & packed-tarball verification:** Releases are built and verified in an isolated worktree (`scripts/drill.mjs`), checking TypeScript compilation, `oxlint`, `publint`, `@arethetypeswrong/cli`, stripped `plurnk-dev` conditions, and first-party client conformance before signed tag finalization ({§lint-gate}, {§package-release-contract}, {§release-finalization}, {§acp-first-party-client-conformance}).

## Known limits and compensating operator controls

| Architectural limit | Why it exists | Compensating operator control |
| --- | --- | --- |
| Admitted `sh` / `python3` / `js` and MCP `stdio` subprocesses share the daemon's OS user and network access | Plurnk is a developer and automation platform designed to run native toolchains without mandatory containerization overhead. | Run `plurnk-service` inside a dedicated OS user, container, VM, or `systemd` unit (`ProtectSystem=strict`, `PrivateTmp=yes`, `ReadWritePaths=`), restrict runtimes with `PLURNK_EXECS_ONLY`, or gate `host` effects with `PLURNK_SERVICE_EFFECT_HOST=review` (or `reject`). |
| Pending client interactions reset on daemon restart, while outbound MCP OAuth tokens persist encrypted on disk | Avoids persisting bearer secrets in SQLite while surviving daemon restarts ({§oauth-continuation}, {§session-causal-admission}). | Workspace MCP OAuth grant files use `0600` permissions and AES-256-GCM keyed from the workspace state directory's `0600` `.oauth-key`; rotating or deleting `.oauth-key` fails closed cleanly. |
| Provider prompts and tool outputs leave the host to the selected model provider | Inference requires transmitting assembled packets to the configured upstream provider ({§provider-interface}). | Select self-hosted or enterprise-contracted providers via `PLURNK_MODEL_<alias>`, exclude sensitive paths with `!glob` membership rules ({§membership}), and scrub subprocess environments via `PLURNK_SERVICE_EXEC_ENV_EXCLUDE` ({§execution-output-identity}). |
| SQLite database (`plurnk.db`) stores workspace snapshots, logs, and turn sources in cleartext on disk | Enables zero-dependency local persistence, FTS5 search, and offline forensic digests ({§db-durability}, {§content-store}). | Store `PLURNK_SERVICE_STATE_ROOT` on an encrypted volume with `0700` directory permissions ({§host-path-layout}) and configure `PLURNK_SERVICE_RETAIN_*` to bound historical payload retention. |
