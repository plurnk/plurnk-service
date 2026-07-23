# Architecture

PLURNK has one daemon process and multiple clients. The daemon owns model
execution and persistent state. Clients present that state and submit user
actions.

```text
CLI / TUI / editor clients
            |
            | AG-UI over HTTP/SSE
            v
       plurnk-agui
            |
            | in-process daemon API
            v
        plurnk-core
       /     |      \
providers  schemes  executors
            |
         entries and streams
            |
          SQLite
```

## Processes

### Daemon

`@plurnk/plurnk-service` is the only long-running platform process. It:

- loads configuration and installed plugins;
- owns the SQLite database;
- creates and resumes workspaces, workers, loops, and turns;
- assembles the model request;
- invokes a provider;
- validates and dispatches model operations;
- publishes lifecycle events to clients.

Plugins run in the daemon process. They are package boundaries, not security
boundaries.

### Clients

The `plurnk` CLI/TUI and editor integrations are separate processes. They:

- collect user input and local terminal/editor state;
- call the AG-UI management and run endpoints;
- render events and results;
- present proposals and send the user's decision.

Clients do not schedule model turns or infer daemon state. A client-side
automatic proposal decision is still an explicit client decision. Daemon-side
automatic execution is loop policy and does not require a client round trip.

### Model endpoints

Provider plugins adapt the daemon's provider contract to local or remote model
APIs. Provider-specific transport and authentication remain outside core.

## Package boundaries

| Concern | Owner |
| --- | --- |
| Model-facing language and shared schemas | `plurnk-grammar` |
| Persistence, loops, workers, packet assembly, dispatch | `plurnk-core` |
| External client protocol | `plurnk-agui` |
| Model API adapters and model catalog | `plurnk-providers*`, `plurnk-models`, `plurnk-aliases` |
| Addressable resources | `plurnk-schemes*` |
| Content parsing, rendering, search, and tokenization | `plurnk-mimetypes*` |
| Executable capabilities | `plurnk-execs*` |
| Shared package discovery and model reference material | `plurnk-meta` |

Core may orchestrate a plugin capability but should not reimplement its domain
logic. A plugin should depend on core contracts only when it actually needs
them. Shared shapes have one schema owner.

## Request lifecycle

1. A client creates or attaches to a workspace and worker through AG-UI.
2. The daemon persists the prompt and constructs a loop.
3. Core assembles a packet from durable policy, workspace context, worker log,
   available capabilities, and current runtime state.
4. A provider returns a model emission.
5. The grammar validates and parses the emission.
6. Core dispatches operations to its storage layer or the owning plugin.
7. Results are persisted and included in the next turn.
8. A terminal operation completes the loop; otherwise the next turn begins.

A mutating operation may pause as a proposal. Client-managed approval resumes
the paused loop with an explicit decision. Loop automatic mode resolves eligible
operations inside the daemon. These are separate paths with separate tests.

## State

SQLite is the source of truth for daemon state. The principal relationships are:

```text
workspace
  ├── entries
  └── workers
        └── loops
              ├── turns
              └── log entries
```

The filesystem remains authoritative for project files. Workspace membership
determines which files are materialized into entries. The database records the
agent-visible representation and execution history; it is not a replacement for
the repository.

## Source, build, and installed artifacts

There are three legitimate runtime forms:

1. source execution for package development;
2. built `dist` execution from a checkout;
3. an installed npm package.

They must not be treated as interchangeable. Binary and whole-product tests use
built output. A running client and daemon must report enough provenance to
identify their package version, artifact location, and source revision when
available. The canonical dogfood launcher builds and starts one named candidate
so client and daemon cannot silently come from different revisions.

## Contracts and documentation

Schemas define shared wire shapes. Package specifications define public behavior
and invariants owned by that package. Tests provide executable examples.

Architecture documentation describes boundaries and flow; it does not prescribe
implementation by analogy. Design history remains in Git and GitHub issues.
