# @plurnk/plurnk-execs-mcp

MCP-bridge runtime executor for [plurnk-service](https://github.com/plurnk/plurnk-service)'s `exec` scheme. Each [Model Context Protocol](https://modelcontextprotocol.io/) server you configure becomes its own `EXEC` tag; the server's tools are called from the op body, and the output is contained behind the server's address — READ back slice-wise, never dumped into context.

Built on the [plurnk-execs](https://github.com/plurnk/plurnk-execs) framework, using the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk).

> **Opt-in.** Unlike the other siblings, this one is **not** in the `@plurnk/plurnk-execs-all` bundle: it pulls the MCP SDK's dependency tree and is inert until you configure a server, so install it explicitly when you want MCP.

## Why a bridge, not a special case

An MCP server is an external **tool** surface — which is exactly `exec://` territory. So MCP is not a new client/provider concern; it's just an executor. The model never speaks MCP: it emits `EXEC`, the executor translates to/from the protocol, and the JSON result lands on a `results` channel like any other tool (sqlite, jq, search). The client never knows MCP exists.

The payoff is **containment**: a 30-tool server costs **one** hot-path line (the `example`) plus an on-demand tool catalog — instead of dumping every tool's schema into context every turn. That is the thing that makes MCP not suck (plurnk-execs#10).

## Per-deployment tags (dynamic discovery)

Tags here aren't known at publish time — they're the servers *you* configure. The package declares no static `plurnk.runtimes[]`; instead it ships a `runtimesModule` hook the framework's `discover()` calls at boot to materialize one tag per configured server (plurnk-execs#10, SPEC §3.1).

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
| `PLURNK_EXECS_MCP_INSTALL` | off | may **arbitrary** MCP tooling be **added at runtime** (a future `/mcp` hotload route)? Off ⇒ only env-declared servers exist |

The single security boundary is what may be *added*, not what may be *activated*. Servers you declare in env are always honored; enabling or disabling an already-present tag is never gated. Runtime hotloading of operator-unvetted servers is refused unless `PLURNK_EXECS_MCP_INSTALL=1`.

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
- **OAuth** — when an http server demands OAuth, `connect` returns **401** and the executor emits **`mcp_auth_required`** (`{ server, resource }`, status 401). The **executor owns the OAuth protocol** (it has the SDK, config, and transport) and exposes the non-interactive mechanics — no consent round-trip lands here:
  - **`authorize(server, { redirectUri })`** → `{ authorizationUrl, pkce }` — RFC 9728 discovery + dynamic client registration + PKCE. Returns the URL to open and an opaque `pkce` blob the caller round-trips (no server-side session).
  - **`completeAuth(server, { code, pkce, redirectUri })`** → `{ headers }` — the authorization-code token exchange, returning the `Authorization: Bearer …` headers.
  - **`install(server, headers)`** — overlays those headers onto the server's resolved config and evicts the cached client so the next call carries the token. (This is the correct primitive for an env-declared server; `registerServer` can't inject onto one, since an env server wins over an injected rival.)

  The consumer stays a **thin passthrough**: `mcp_auth_required` → `authorize()` → propose the URL through its proposal lifecycle → the **client** opens it (a loopback `redirectUri`) and returns the `code` → `completeAuth()` → `install()` → re-dispatch. Service touches no OAuth mechanics and hosts no HTTP; the client owns the browser leg. No `authProvider` is wired into the transport, so the interactive leg stays where the UI is. Static-token servers (`_HEADERS` / `_ENV`) need none of this.

## Calling tools

The **tool is the `(target)` slot**; its arguments are the body — a single JSON object:

```
<<EXEC[<server>](<tool>):<json-arguments>:EXEC
```

```
<<EXEC[github](create_issue):{"title":"Bug","body":"…"}:EXEC
<<EXEC[github](list_repos):EXEC          # no-argument tool → empty body
```

This is the family's `(target)`/body split: for an executable runtime the target is the program and the body its stdin; here the target is the **tool** and the body its **arguments**. Putting the tool in `(target)` also makes it visible to the synchronous `effect()` hook — which is what enables per-tool gating (below).

Run a tag with **no target** (`?`, `help`, or an empty body) to write the server's live tool catalog — names, descriptions, and input JSON **schemas** — to the `results` stream, so the model learns each tool's argument shape before calling it:

```
<<EXEC[github]:?:EXEC
```

## Output & gating

The tool result is written as JSON (`application/json`) to the `results` channel. A tool that reports `isError` closes the channel errored with status 500.

Gating is **per tool**, by the tool's `readOnlyHint`. Because the tool is the `(target)` slot, the synchronous `effect()` hook can see it and consult the hint cached from the catalog: a read-only tool (`readOnlyHint: true`) reports `effect → read` and **auto-runs**; a mutating tool — or one not yet probed — reports `effect → host` and is **proposed** for approval; listing the catalog is read-only. (This is the per-tool gating plurnk-execs#13 parked while the tool lived in the body.)

Failures emit a `TelemetryEvent` (`source: "exec:<server>"`): `mcp_not_configured`, `mcp_unreachable`, `mcp_list_failed`, `mcp_bad_arguments`, `mcp_tool_error`, and `mcp_auth_required` (see [Authorization](#authorization)).

## Lifecycle

Connections are long-lived and cached (one client per server, opened lazily, reused across runs). `closeAll()` disconnects every open server — call it on daemon shutdown so child stdio servers don't leak.

## Tests

`test:lint`, `test:unit` — the unit suite spawns a real stdio MCP server fixture and exercises the bridge end-to-end (probe, tool call, catalog, error, abort).
