# Architecture

PLURNK is a contract-first platform with one composed daemon and multiple thin
clients. This document owns the ecosystem map and cross-boundary flow. Package
specifications own behavior; design history belongs in Git and forge issues.

## Standards boundary

PLURNK is an engine between standards. Nodes outside PLURNK are interface
specifications; standards named inside PLURNK govern internal contracts.
Boundary adapters implement their owning standards rather than restate them.
Dotted interfaces are explicitly deferred.

```mermaid
flowchart LR
    AGUI["AG-UI Specification"] --- PLURNK["plurnk<br/><br/>JSON Schema · RFC 9457<br/>SARIF regions · OTel<br/>RFC 3986 · WHATWG URL<br/>IANA media types"]
    MCP["MCP Specification"] --- PLURNK
    OPENAI["OpenAI Specification"] --- PLURNK
    PLUGIN["Plurnk Plugin<br/>(exec / scheme)<br/>plurnk-owned interface"] --- PLURNK

    PLURNK -.-> A2A["A2A Specification<br/>(deferred)"]
    PLURNK -.-> X402["x402 Specification<br/>(deferred)"]
    PLURNK -.-> AP2["AP2 Specification<br/>(deferred)"]
    PLURNK -.-> DID["W3C DID Specification<br/>(deferred)"]

    classDef deferred stroke-dasharray: 6 4;
    class A2A,X402,AP2,DID deferred;
```

## Ecosystem

```mermaid
flowchart LR
    contracts["plurnk-contracts<br/>language + shared wire"] --> core
    packet["plurnk-plurnkdown<br/>packet projection"] --> core
    meta["plurnk-meta<br/>discovery + teaching"] --> core
    providers["Provider family"] --> core
    capabilities["Scheme / executor / mimetype families"] --> core
    mcp["MCP host module<br/>tools · resources · prompts · tasks"] --> core
    hooks["plurnk-hooks<br/>exact command events"] --> core
    core["plurnk-service<br/>composed daemon"]
    core --> agui["plurnk-agui<br/>client interface"]
    agui --> clients["CLI / TUI / Neovim / web clients"]
```

[`plurnk-contracts/plurnk.md`](./plurnk-contracts/plurnk.md) is the
model-facing canon. It is intentionally narrower than the tolerant parser.
Language and schema behavior remain owned by the contracts package; this root
document does not restate their teaching.

## Package ownership

| Contract area                                             | Owner                                                        | Normative source                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Model language, parser, shared types/wire                 | `@plurnk/plurnk-contracts`                                   | [`plurnk.md`](./plurnk-contracts/plurnk.md), [`SPEC.md`](./plurnk-contracts/SPEC.md)                           |
| Optional GBNF sentence validator                          | `@plurnk/gbnf`                                               | [`gbnf/SPEC.md`](./gbnf/SPEC.md)                                                                               |
| Model-packet Markdown projection                          | `@plurnk/plurnk-plurnkdown`                                  | [`plurnk-plurnkdown/SPEC.md`](./plurnk-plurnkdown/SPEC.md)                                                     |
| Discovery, trust predicate, teaching bytes                | `@plurnk/plurnk-meta`                                        | [`plurnk-meta/SPEC.md`](./plurnk-meta/SPEC.md)                                                                 |
| Provider adaptation and model selection                   | `@plurnk/plurnk-providers`, aliases, model-data package      | [`plurnk-providers/SPEC.md`](./plurnk-providers/SPEC.md), [`plurnk-aliases/SPEC.md`](./plurnk-aliases/SPEC.md) |
| Addressable capability framework                          | `@plurnk/plurnk-schemes` and installed scheme packages       | [`plurnk-schemes/SPEC.md`](./plurnk-schemes/SPEC.md)                                                           |
| Executable capability framework                           | `@plurnk/plurnk-execs` and installed executor packages       | [`plurnk-execs/SPEC.md`](./plurnk-execs/SPEC.md)                                                               |
| Content detection and projection                          | `@plurnk/plurnk-mimetypes` and installed handler packages    | [`plurnk-mimetypes/SPEC.md`](./plurnk-mimetypes/SPEC.md)                                                       |
| Persistence, workers, turns, dispatch                     | `@plurnk/plurnk-service`                                     | [`plurnk-core/SPEC.md`](./plurnk-core/SPEC.md)                                                                 |
| External HTTP/SSE client protocol                         | `@plurnk/plurnk-agui`                                        | [`plurnk-agui/SPEC.md`](./plurnk-agui/SPEC.md)                                                                 |
| Exact-command lifecycle hooks                             | `@plurnk/plurnk-hooks`                                       | [`plurnk-hooks/SPEC.md`](./plurnk-hooks/SPEC.md)                                                               |
| MCP host/client                                            | `@plurnk/plurnk-mcp`                                         | [`plurnk-mcp/SPEC.md`](./plurnk-mcp/SPEC.md)                                                                   |
| CLI, TUI, Neovim, and web presentation                    | Separate open-client repositories                            | Consume AG-UI; they do not own daemon scheduling or persisted truth.                                           |

Family packages define extension contracts. Installed adapters implement those
contracts. Core composes them but does not absorb their domain logic. Shared
facts have one schema and one specification owner. Capability frameworks do not
depend on their leaf consumers; the service manifest is the sole owner of its
default leaf set, while compatible third-party leaves extend it through the
same installation and discovery path ({§default-plugin-ownership}).

## Process composition

```mermaid
flowchart LR
    clients["Thin clients"] <-->|AG-UI over HTTP / SSE| daemon["One @plurnk/plurnk-service process<br/><br/>AG-UI · core · daemon modules<br/>provider and capability adapters"]
    daemon <-->|Provider protocols| endpoints["Local or remote model endpoints"]
    daemon <-->|Filesystem / Git| project["Project filesystem + Git"]
    daemon <-->|SQLite file I/O| database[(Durable database)]
```

`@plurnk/plurnk-service` is the only long-running platform process. Plugin and
module packages run inside it; a package boundary is not a security boundary.
AG-UI owns client transport, while clients own presentation and explicit user
decisions. MCP is an optional in-process host/client under core's
`{§module-lifecycle}` and `{§module-workspace-capabilities}` seams. MCP server
attachments are workspace-shared capabilities; their tools and resources join
the ordinary executor, scheme, proposal, entry, and client-action paths.

## Model-loop request flow

```mermaid
sequenceDiagram
    participant Client
    participant AGUI as AG-UI
    participant Core
    participant Store as SQLite
    participant Provider
    participant Contracts
    participant Owner as Operation owner

    Client->>AGUI: user prompt
    AGUI->>Core: ApplicationPort call
    Core->>Store: persist accepted input and loop state
    Core->>Provider: rendered packet and generation context
    Provider-->>Core: normalized response and usage evidence
    Core->>Contracts: parse projected PLURNK content
    Contracts-->>Core: admitted statements or diagnostics
    loop dispatched statements
        Core->>Owner: route through the owning operation seam
        Owner-->>Core: universal operation result
        Core->>Store: commit result and durable evidence
    end
    Core->>Store: commit turn and loop state
    Core-->>AGUI: lifecycle, proposal/interaction, result, and terminal events
    AGUI-->>Client: protocol projection
```

Core owns packet assembly at `{§packet-assembly}` and durable result handling at
`{§operation-results}`. Provider, capability, and AG-UI details remain in their
own specifications. A proposal or client interaction pauses its owning
operation until an explicit client decision, while core-owned proposal policy
may resolve only proposals automatically; client convenience and daemon
authority are not interchangeable.

## State authority

| Concern                                 | Authority                                                                                             |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Workspaces, workers, loops, turns, logs | SQLite through core's tagged lifecycle and persistence contracts.                                     |
| Project bytes and Git membership        | The project filesystem and repository; database entries are the agent-visible projection.             |
| Active worker drains, wakes, cancellation | Process-local `DrainSupervisor` state reconciled against durable state; see `{§worker-loop-lifecycle}`. |
| Provider calls and process teardown       | `Engine` owns provider-call state; `Daemon` owns reverse-order process teardown.                       |
| Client binding and presentation         | The client-interface package and client process; neither becomes persisted daemon truth by accident.  |
