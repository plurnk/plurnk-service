# @plurnk/plurnk-execs-mcp

The [Model Context Protocol](https://modelcontextprotocol.io/) bridge for [plurnk-service](https://github.com/plurnk/plurnk-service) — **both faces**. Each MCP server you configure becomes its own `EXEC` tag whose **tools** are called through the op grammar, and the server's own state — its capability catalog, **resources**, and **prompts** — is read through the `mcp://` scheme. Everything is contained behind addresses, READ back slice-wise, never dumped into context.

```
<<EXEC[github](create_issue):{"title":"Bug"}:EXEC       call a tool — result lands at github://<coord>#results
<<READ(mcp://github/)::READ                             the server's capability-aware catalog
<<READ(mcp://github/resources/<encoded-uri>)::READ      read a resource the server holds
```

Whoever owns the state names the address (plurnk-service#484): a tool **result** is a plurnk event and lands behind the *tag's* address like every runtime's output; a **resource** is the *server's* state and lives behind `mcp://`.

Built on the plurnk-execs framework, using the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

> **Heavy + inert until configured.** This sibling pulls the MCP SDK's full dependency tree and does nothing until you configure a server — no tags register and no code runs until a `PLURNK_EXECS_MCP_<server>` exists.

## Why a bridge, not a special case

An MCP server is an external surface of **tools** (model-invoked), **resources** (application-read), and **prompts** — and plurnk already has both verbs: `EXEC` invokes, schemes read. So MCP is not a new client/provider concern; tools ride the executor face and server-side state rides the scheme face. The model never speaks the protocol — it emits the same DSL it uses everywhere, and the word `mcp` in an address carries no more protocol than `http` does.

The payoff is **containment**: a 30-tool server costs **one** hot-path line (the `example`) plus an on-demand catalog — instead of dumping every tool's schema into context every turn. That is the thing that makes MCP not suck (plurnk-execs#10).

## Per-deployment tags (dynamic discovery)

Tags here aren't known at publish time — they're the servers *you* configure. The package declares no static `plurnk.runtimes[]`; instead it ships a `runtimesModule` hook the framework's `discover()` calls at boot to materialize one tag per configured server (plurnk-execs#10, SPEC §3.1). The `mcp://` scheme face is one static handler for all of them — the server is the URL authority.

## Configuration (environment)

Mirrors the model-alias convention (`PLURNK_MODEL_<alias>=<provider>/<model>`): **one var per server, the server is the var**, and the set is discovered by enumerating the namespace — there is no list var. The suffix case-folds to the tag, so `PLURNK_EXECS_MCP_github` and `PLURNK_EXECS_MCP_GITHUB` are the same server.

| Var | Notes |
|---|---|
| `PLURNK_EXECS_MCP_<server>` | **the server** — its value is the target: an `https://…` URL (streamable-HTTP) **or** a command line (stdio) |
| `PLURNK_EXECS_MCP_<server>_ENV` | stdio: JSON env overlay for the child process (where tokens go) |
| `PLURNK_EXECS_MCP_<server>_HEADERS` | http: JSON request headers (auth) |

The transport is inferred from the target: an `http(s)://` value connects over HTTP, anything else is spawned as a stdio command. `_ENV` / `_HEADERS` are reserved companion suffixes and `INSTALL` is a reserved control key (below), so a server can't be named to end in them or be named `install`. Two keys that case-fold to one server is a fail-hard config error.

### Security: the install gate

| Var | Default | Notes |
|---|---|---|
| `PLURNK_EXECS_MCP_INSTALL` | off | may **arbitrary** MCP tooling be **added at runtime** (via `installServer`, below)? Off ⇒ only env-declared servers exist |

The single security boundary is what may be *added*, not what may be *activated*. Servers you declare in env are always honored; enabling or disabling an already-present tag is never gated. Runtime hotloading of operator-unvetted servers is refused unless `PLURNK_EXECS_MCP_INSTALL=1` — on both faces (the scheme applies the same defense-in-depth check at read time).

### Runtime install

**`installServer(name, { target, headers?, hotload })`** → `{ status, detail }` — install an MCP server as a live `EXEC[<name>]` runtime mid-workspace (plurnk-execs-mcp#3 / plurnk-service#355). Self-contained MCP orchestration: it checks the `PLURNK_EXECS_MCP_INSTALL` gate, injects the config, builds the `Mcp` executor, connect-probes it, and hands the consumer's `hotload` callback a `HotloadRegistration` `{ decl, executor, availability }` — all execs-framework types, so the kernel owns the registry and execs-mcp never touches its `RegistryEntry`. Probes before registering: a target that won't connect returns `502` and rolls back its config rather than parking a dead tag (env-declared servers, operator-vetted, register while down). `501` when the gate is off. Distinct from `install()` above (the OAuth bearer overlay). The *who-may-install* permission is the consumer's edge decision; *is-install-enabled* is this gate.

```bash
# http server
PLURNK_EXECS_MCP_github="https://api.githubcopilot.com/mcp/"
PLURNK_EXECS_MCP_github_HEADERS='{"Authorization":"Bearer …"}'

# stdio server
PLURNK_EXECS_MCP_FIGMA="npx -y figma-developer-mcp --stdio"
PLURNK_EXECS_MCP_FIGMA_ENV='{"FIGMA_API_KEY":"…"}'
```

### Authorization

Two ways a server gets credentials:

- **Static token** — put it where the transport carries it: `PLURNK_EXECS_MCP_<server>_HEADERS='{"Authorization":"Bearer …"}'` for http, or `PLURNK_EXECS_MCP_<server>_ENV` for a stdio child. The executor is a pass-through carrier — it never mints or refreshes a token.
- **OAuth (Device Authorization Grant, RFC 8628)** — when an http server demands OAuth, `connect` returns **401** and the executor emits **`mcp_auth_required`** (`{ server, resource }`, status 401). The **executor owns the OAuth protocol** (SDK, config, transport) and exposes the non-interactive mechanics. There is **no redirect and no local server** — so the flow works identically whether the daemon is local or remote (SSH / bastion / jumpbox), which the old loopback authorization-code flow could not: it redirected to `127.0.0.1` on the *daemon* host, unreachable from the user's browser (plurnk-execs-mcp#2).
  - **`authorize(server, { scope? })`** → `{ verificationUri, verificationUriComplete?, userCode, interval, expiresIn, device }` — RFC 9728 discovery + RFC 7591 DCR + the device-authorization request. Show the user `verificationUri` + `userCode` (or `verificationUriComplete`, which embeds the code). `device` is an opaque JSON blob the caller round-trips into `poll()`. **Fails hard** if the provider advertises no `device_authorization_endpoint` — the device grant is required, no fallback.
  - **`poll(server, { device })`** → `{ status, headers? }` — one device-token poll. `status` ∈ `pending` / `slow_down` (poll again, honoring `interval`) / `authorized` (carries the `Authorization: Bearer …` headers) / `denied` / `expired`. The **caller** drives the loop.
  - **`install(server, headers)`** — overlays those headers onto the server's resolved config and evicts the cached client so the next call carries the token. (The correct primitive for an env-declared server; `registerServer` can't inject onto one, since an env server wins over an injected rival.)

  The flow: `mcp_auth_required` → `authorize()` → the **client** shows `verificationUri` + `userCode` (user approves on *any* device) → the client **polls** `poll()` until `authorized`, honoring `interval` → `install()` → re-dispatch. Service is a thin relay; the client owns the display + poll loop; neither hosts an HTTP callback. Static-token servers (`_HEADERS` / `_ENV`) need none of this. Both faces share one connection per server, so a token installed once serves tool calls and `mcp://` reads alike.

## Calling tools (the executor face)

The **tool is the `(target)` slot**; its arguments are the body — a single JSON object:

```
<<EXEC[<server>](<tool>):<json-arguments>:EXEC
```

```
<<EXEC[github](create_issue):{"title":"Bug","body":"…"}:EXEC
<<EXEC[github](list_repos):EXEC          # no-argument tool → empty body
```

This is the family's `(target)`/body split: for an executable runtime the target is the program and the body its stdin; here the target is the **tool** and the body its **arguments**. Putting the tool in `(target)` also makes it visible to the synchronous `effect()` hook — which is what enables per-tool gating (below).

Run a tag with **no target** (`?`, `help`, or an empty body) to write the server's live **capability-aware catalog** to the `results` stream — tools (with input JSON **schemas** and annotations), resources, resource templates, and prompts, each section present exactly when the server advertises that capability:

```
<<EXEC[github]:?:EXEC
```

## Reading server state (the mcp:// scheme face)

What the server **holds** — as opposed to what its tools **do** — is addressable, so it is READ, not EXEC'd (plurnk-service#484):

```
<<READ(mcp://<server>/)::READ                          the capability-aware catalog (same JSON as `?`)
<<READ(mcp://<server>/tools/<name>)::READ              one tool's schema + annotations
<<READ(mcp://<server>/resources/<encoded-uri>)::READ   read a resource
<<READ(mcp://<server>/prompts/<name>?<args>)::READ     fetch a prompt (string-valued arguments as query params)
```

A resource's own URI rides as **one** path segment, `encodeURIComponent`-encoded: `file:///log.txt` → `mcp://build/resources/file%3A%2F%2F%2Flog.txt`. Resource **templates** are listed in the catalog; expand one and read the expanded URI through the same rule. A single-part text resource lands with its **own** mimetype; anything else (multi-part, binary blob) lands as a JSON envelope.

Reads are capability-gated exactly: a primitive the server doesn't advertise fails as `mcp_unadvertised` (501), never as a generic transport error. Reading is read-shaped by construction — no proposal gate — while every mutation stays on the EXEC face where `effect()` gates it.

## Output & gating

The tool result is written as JSON (`application/json`) to the `results` channel. A tool that reports `isError` closes the channel errored with status 500.

Gating is **per tool**, by the tool's `readOnlyHint`. Because the tool is the `(target)` slot, the synchronous `effect()` hook can see it and consult the hint cached from the catalog: a read-only tool (`readOnlyHint: true`) reports `effect → read` and **auto-runs**; a mutating tool — or one not yet probed — reports `effect → host` and is **proposed** for approval; listing the catalog is read-only. (This is the per-tool gating plurnk-execs#13 parked while the tool lived in the body.)

Failures emit a `TelemetryEvent`. Executor face (`source: "exec:<server>"`): `mcp_not_configured`, `mcp_unreachable`, `mcp_list_failed`, `mcp_bad_arguments`, `mcp_tool_error`, `mcp_auth_required` (see [Authorization](#authorization)). Scheme face (`source: "scheme:mcp"`): `mcp_not_configured`, `mcp_unreachable`, `mcp_auth_required`, `mcp_unadvertised`, `mcp_unknown_tool`, `mcp_bad_arguments`, `mcp_read_failed`, `bad_target`, `bad_path`.

## Deliberately declined — the producer boundary

MCP also defines **client** capabilities where the *server* calls back into the client: **sampling** (the server asks our model to complete), **elicitation** (the server asks our user a question), and resource **subscriptions** (the server pushes change notifications). This bridge declines all three — an executor/scheme is a producer; it can reach neither the model loop nor the user, and a plugin that could would breach the substrate boundary. Declining is MCP-conformant: a client advertises what it supports. A changed resource is a re-READ of a stable address; if a future core seam wants server-push, that is a daemon design, not a bridge patch.

## Lifecycle

Connections are long-lived and cached (one client per server, opened lazily, reused across runs, shared by both faces). `closeAll()` disconnects every open server — call it on daemon shutdown so child stdio servers don't leak.

## Tests

`test:lint`, `test:unit` — the unit suites spawn a real stdio MCP server fixture in three shapes (full: tools + resources + templates + prompts; bare: tools only; notemplates: the -32601 tolerance path) and exercise both faces end-to-end: probe, tool call, catalog, resource/template/prompt reads, the encoding rule, capability gates, error, abort.
