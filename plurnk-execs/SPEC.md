# plurnk-execs — Specification

Author contract for `@plurnk/plurnk-execs-*` runtime packages. Core consumes
the framework; executor leaves implement it.

## §executor-role Role and ownership

An executor owns one declared runtime-specific invocation shape, its mapping
from that EXEC body and realized target to work, declared output channels,
environment availability, and effect classification. The consumer owns
dispatch, invocation-shape enforcement and target realization, proposal policy,
storage, subscriptions, deadlines, polling, cancellation delivery, packet
projection, and all reads of stored output.

```mermaid
flowchart LR
    Manifest["package runtime declarations"] --> Discover["framework discovery"]
    Discover --> Registry["runtime-tag registry"]
    Registry --> Probe["consumer instantiates and probes each tag"]
    Request["EXEC with runtime tag"] --> Effect["executor effect fact"]
    Effect --> Admission["consumer proposal policy"]
    Admission --> Stream["consumer creates tag-addressed stream"]
    Stream --> Run["executor run with consumer sinks"]
    Run --> Channels["stored output channels"]
    Channels --> Packet["consumer observation and READ/FIND"]
```

`SubprocessExecutor` is the concrete base for command runtimes. It owns child
process spawning, stdout/stderr streaming, environment handoff, exit status,
and process-group cancellation. A subprocess leaf normally overrides only its
spawn recipe and availability binary.

## §executor-contract Author surface

```ts
abstract class BaseExecutor {
    readonly runtime: string;
    readonly glyph: string;

    abstract get channels(): Readonly<Record<string, ChannelDecl>>;
    get defaultChannel(): string;
    abstract run(args: ExecArgs): Promise<ExecResult>;
    probe(signal?: AbortSignal): Promise<RuntimeAvailability>;
    effect(target: string | null): Effect;
    toolRegistry?(): RuntimeToolRegistry;
}

interface ChannelDecl {
    mimetype: string;
    defaultState?: "active" | "closed" | "errored";
}

interface ExecArgs {
    runtime: string;
    body: string;
    cwd: string | null;
    target: string | null;
    env?: NodeJS.ProcessEnv;
    signal: AbortSignal;
    write(channel: string, chunk: string, mimetype?: string): void;
    setState(channel: string, state: ChannelState): void;
    emit(notice: Notice): void;
    interact(request: ClientInteractionRequest): Promise<ClientInteractionResolution>;
    entry?(
        path: string,
        content: string | null,
        opts: { tags: string[]; mimetype?: string },
    ): Promise<string>;
}

`ExecArgs` deliberately carries **no Worker identity**: an executor is a
worker-agnostic capability, and `run` may assume nothing about which Worker,
Loop, or workspace invoked it beyond the arguments given. A runtime whose
behavior depends on a Worker — an attached MCP server, a Worker Functionality
manager — is published per Worker by its owning module, closing over that
identity at publication ({§functionality-model-projection} in the core
specification; the MCP host is the precedent). Consumers must not smuggle
identity through `env` or `body` conventions.

interface RuntimeAvailability {
    available: boolean;
    detail?: string;
}

type Effect = "pure" | "read" | "host";
```

The framework constructs one executor per matched runtime tag with
`{ runtime, glyph }`. A package that declares several tags may branch on
`this.runtime`; it must not retain per-run state on the executor instance. The
derived addressable runtime scheme retains `glyph` for client discovery
({§manifest-client-display}); runtime aliases remain excluded from scheme
model-teaching because the EXEC invocation directory owns that hot-path
surface.

### §executor-sinks Inputs and sinks

| Field      | Contract                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `runtime`  | The matched tag.                                                                                        |
| `body`     | The authored EXEC body, interpreted according to the runtime's invocation declaration.                |
| `cwd`      | Consumer-selected project working directory, or `null` for a runtime that has none.                     |
| `target`   | Consumer-realized optional EXEC target. Its representation and role come from the invocation declaration. |
| `env`      | Exact child environment when supplied. A subprocess must use it instead of reconstructing host policy.  |
| `signal`   | Consumer cancellation. Every executor must honor it at each cancellable boundary.                       |
| `write`    | Append to a declared channel. An optional mimetype replaces that channel's per-call output type.        |
| `setState` | Move a declared channel from `active` to terminal `closed` or `errored`.                                |
| `emit`     | Publish a transient, nonterminal Notice.                                                                |
| §executor-interaction-sink `interact` | Await one contracts-owned client interaction ({§client-interaction-wire}). Core owns identity, pending-state durability, client presentation, and cancellation; the executor owns the request and returned payload's meaning. |
| `entry`    | Optionally request consumer-owned entry materialization and receive its canonical model-facing address. |

The executor receives callbacks, never a database, subscription registry,
packet builder, or wake mechanism. Related lifecycle behavior remains on the
consumer side of {§executor-role}.

### §executor-channels Channels

The executor declares every channel it may write. The consumer seeds a stream
entry from that declaration and rejects writes or state transitions for an
undeclared channel. `defaultChannel` is the fragmentless READ channel and
defaults to the first declared channel. Subprocess executors declare
`stdout` and `stderr`, with `stdout` first; logical runtimes commonly declare
`results`. The declared or per-write mimetype remains the channel's content
type through storage and model observation; the consumer derives incremental
versus atomic publication from that type under {§exec-stream}.

An executor that produces a generated JSON value uses the contracts-owned
`renderJsonResult` projection ({§json-result-rendering}). This gives a
top-level result array one addressable item per physical line without
reformatting arbitrary source JSON read from an entry.

### §executor-results Results, failures, and notices

`run()` resolves one universal `SchemeResult`; `ExecResult` adds an optional
subprocess `exitCode`. A result with `status >= 400` carries exactly one RFC
9457 Problem whose status agrees with the result. Expected runtime failures
resolve as failure results and leave affected channels `errored`; they do not
throw. The consumer validates the boundary and converts a throw or invalid
result into its own durable failure before closing the stream.

A nonzero subprocess exit directs the caller to inspect both stdout and stderr
because either may contain the useful diagnostic. Third-party diagnostic text
entering a Problem is bounded with `ErrorDetail` and the required
`PLURNK_EXECS_ERROR_DETAIL_LIMIT`. Missing or invalid configuration is itself
an `invalid-configuration` failure. Structured diagnostic facts remain
separate Problem extensions.

`emit` is only for transient progress or other nonterminal observations. It
cannot own failure truth, change the terminal result, or drive the scheduler.
The runtime-neutral Notice types are re-exported from
`@plurnk/plurnk-contracts`; they are not redefined by this package.

### §executor-effect Effect is an admission fact

`effect(target)` is pure, synchronous, cheap, and target-classified. The
consumer calls it exactly once for an admitted invocation, before proposal
policy, then preserves that exact fact through application and effect-sensitive
bookkeeping. An installed executor does not parse authored code or commands to
infer safety. Unknown or unclassifiable work remains `host` through the
conservative default.

`target` is the consumer-canonical logical target. It is normally the same
local value later supplied to `run()`. If the consumer will materialize an
addressed source only after acceptance, it may classify against a stable opaque
target-present identity; the executor neither resolves that address nor
reclassifies the materialized path.

| Effect | Executor fact                                | Default consumer admission |
| ------ | -------------------------------------------- | -------------------------- |
| `host` | Runs host code or may mutate host state.     | Human proposal gate.       |
| `read` | Observes external state without mutating it. | Automatically accepted.    |
| `pure` | Has no externally observable side effect.    | Automatically accepted.    |

The classification controls admission policy and may be reused as operational
metadata; it never changes within the invocation. After acceptance, every EXEC
uses the same background stream path: output is not returned in the dispatching
turn. Core owns that composed behavior in {§exec-host-proposes},
{§exec-readpure-ungated}, and {§exec-stream}.

### §executor-probe Availability is per runtime tag

`probe(signal?)` reports whether this runtime tag can work in the current
environment. The default is `{ available: true }`; leaves override it for
external binaries or required configuration. `detail` must be terse and
actionable because the consumer may return it with a 501 failure.

The consumer constructs and probes one executor per tag at boot, concurrently
under a per-probe timeout, then caches each verdict. This is intentionally
per-tag: a multi-tag package can expose only the interpreters actually present.
A probe that spawns or opens a connection passes the supplied signal through so
completion or timeout reaps its work. Probe rejection or timeout makes only
that tag unavailable; a configured default runtime that is absent or
unavailable is a fail-hard boot error.

## §executor-output-address Tag-addressed output

`exec` is the consumer's internal EXEC dispatcher; it is not a model-facing
output namespace. Every available runtime receives one derived read-only
scheme face from its tag, channels, and default channel. The executor authors
no second scheme manifest.

| Output                    | Model-facing address                                               |
| ------------------------- | ------------------------------------------------------------------ |
| Calling worker's stream   | `<tag>:///<loop>/<turn>/<sequence>#<channel>`                      |
| Fragmentless read         | `<tag>:///<loop>/<turn>/<sequence>` → the declared default channel |
| Example subprocess stdout | `sh:///1/2/3#stdout`                                               |
| Example structured result | `sqlite:///1/2/3#results`                                          |

The executor only produces through `write` and `setState`. The consumer stores
the entry and serves every later READ/FIND through uniform entry machinery.
An executor does not implement a private read face, orientation receipt,
slicer, or index. Owner-qualified cross-worker addresses and packet projection
belong to core's {§stream-owner-scoped} and {§exec-stream} contracts.

### §executor-entry-sink Optional materialization

`entry(path, content, { tags, mimetype? })` is a consumer-implemented sink, not
executor access to storage. The consumer materializes or updates an entry,
uses the tags to classify its ordinary journal announcement, and resolves the
canonical model-facing address. Tags never become resource metadata.
`content === null` requests consumer-sourced
acquisition. Rejection means only that this materialization failed; it does not
invalidate the executor's upstream result. When the sink is absent, the
executor preserves its result without inventing a materialization verdict.

## §executor-discovery Discovery and registration

`discover(options?)` scans every scoped and unscoped package under the nearest
`node_modules` for the exact declaration `plurnk.kind === "exec"`. It returns
`{ registry, packageAttributions, skipped, disabled }`, where the registry maps
each flat runtime tag to its declaration and package owner and the package map
carries the canonical attribution fact from {§plugin-attribution}.

```json
{
  "name": "@acme/acme-execs-cobol",
  "plurnk": {
    "kind": "exec",
    "runtimes": [
      {
        "name": "cobol",
        "glyph": "🗄",
        "summary": "Run a COBOL program.",
        "invocation": {
          "body": { "role": "COBOL program", "required": true },
          "example": { "body": "DISPLAY 'HELLO'." }
        }
      }
    ]
  }
}
```

A tag collision is a fail-hard installation error naming both claiming
packages. A package may declare multiple tags backed by the same default
export. Discovery is scope-agnostic; third-party packages participate through
the same contract.

### §executor-installation Installed capability lifecycle

Configuration cannot enable a package that is absent from the consumer-visible
module graph. An executor leaf must be installed under the `node_modules` found
from the running service before discovery can inspect its declaration. The
service assembles every installed member's package-owned `.env.defaults` under
operator configuration {§operator-config-env-defaults}; a leaf may therefore
ship default-disabled without transferring ownership of its key to the host.

| Package state | Effective policy and probe             | Runtime result                                                      |
| ------------- | -------------------------------------- | ------------------------------------------------------------------- |
| Absent        | Any configuration                      | Not discovered, registered, advertised, or dispatchable.            |
| Installed     | Tag disabled in any policy layer       | Listed in `Discovery.disabled`; not registered or advertised.       |
| Installed     | Tag admitted; probe unavailable        | Registered as unavailable; not advertised or dispatchable.          |
| Installed     | Tag admitted; probe available          | Registered, advertised through `availableRuntimes()`, dispatchable. |

An operator value of `PLURNK_EXECS_<TAG>=1` can outrank a package-owned `0`
floor. It does not restore a tag removed by `PLURNK_EXECS_ONLY`, another
consumer layer, or a service hard ceiling. Discovery and policy are evaluated
at boot; changing package membership or configuration requires a restart.

### §executor-runtime-declaration Runtime metadata

| Field         | Meaning                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `name`        | Canonical runtime tag and derived output-scheme name, admitted below.                              |
| `glyph`       | Optional presentation glyph.                                                                       |
| `summary`     | Required one-line description of the capability.                                                   |
| `invocation`  | Required body and target contract, validated and normalized below.                                 |
| `details`     | Optional supplemental Markdown. `docs/<tag>.md` wins over the inline manifest field.               |
| `attribution` | Published per-tag projection of the validated package declaration ({§plugin-attribution}).         |
| `packageName` | Package that owns and default-exports the executor implementation.                                 |

The framework validates and carries the summary, invocation, and supplemental
details as separate facts. The consumer deterministically renders the
model-facing tool document from either the static invocation or the executor's exact
{§executor-tool-registry}; authors never duplicate Summary or Invocation in
prose. A
multi-tag package appears at most once in `Discovery.packageAttributions`, and
only when at least one of its tags survives discovery policy. An instantiated
executor may add attempt-time tags through the shared runtime hook
({§plugin-attribution}).

A package `docs/<tag>.md` remains a valid standalone Markdown document. When
its first line is the exact authoring title `# <tag>`, discovery removes that
line and its following blank line before carrying the remainder as supplemental
details; the generated tool document owns the one model-facing H1.

§executor-invocation Every runtime declares exactly one invocation contract:

| Field              | Contract                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `body.role`        | One-line model-facing description of the authored body.                                                    |
| `body.required`    | When true, an empty body is refused before effect admission.                                               |
| `target`           | Omitted when this runtime accepts no target; a present authored target is then refused.                    |
| `target.role`      | One-line model-facing description of the target.                                                          |
| `target.required`  | When true, an absent target is refused before effect admission.                                           |
| `target.kind`      | One of the structural realization modes below.                                                            |
| `target.directory` | Optional `"cwd"`: only a local directory becomes `cwd`; every non-directory remains the declared target. |
| `exclusive`        | Optional `true`: body and target are alternative inputs and supplying both is refused.                    |
| `example`          | Concise executable witness with a one-line `body`, `target`, or both as the declared shape permits. |
| `signature`        | One-line structural body signature for a schema-backed invocation; no fabricated argument values. |

| Target kind | Consumer realization                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `literal`   | Preserve the complete authored target string. It is an executor identifier, never a scheme read or filesystem classification. |
| `path`      | Accept only a local or `file://` path and pass that path directly, subject only to an explicit directory rule.                 |
| `resource`  | Pass a local/file path directly; resolve a non-file data-scheme address through one exact READ and materialize its string representation to a temporary file. |

Every EXEC must supply at least a body or target even when neither field is
independently required. A target's meaning never changes because the body is
empty or non-empty. `exclusive` requires a target declaration; `directory` is
valid only for `path` and `resource` target kinds. Exactly one of `example` or
`signature` is present. An example must satisfy the same required, refused,
and exclusive buckets and parse as exactly one EXEC section for the runtime. A
signature is presentation, not an executable example; dispatch still enforces
the invocation's body and target declarations. An invocation declaration
with a missing field, unknown field, invalid combination, multiline role, or
wrong primitive type is a fail-hard plugin contract violation before
registration. Static, dynamic-hook, and module-owned runtimes use this same
validation path. The enclosing runtime declaration is closed to `name`,
`glyph`, `summary`, `invocation`, and `details`; unknown or mistyped metadata is a
contract violation rather than silently ignored teaching.

§executor-tool-registry A runtime representing a finite family of exact tools
may implement `toolRegistry()` and return one immutable snapshot:

```ts
interface RuntimeToolRegistry {
    tools: readonly {
        target: string;
        summary: string;
        invocation: RuntimeInvocation;
        details?: string;
    }[];
}
```

Each entry owns one canonical literal target, one nonempty one-line summary,
its complete invocation contract, and optional supplemental Markdown. Its
invocation declares that target bucket as required and
`literal`; duplicate targets, divergent example targets, or malformed
invocations fail the plugin boundary. The exact target must round-trip through
the language's canonical target-slot escaping. The closed `tools` set replaces the
runtime's generic invocation for model presentation and dispatch admission:
an empty set exposes and admits no target, with no generic fallback. Core uses
the selected entry's invocation for bucket validation before calling
`effect()`.

The same snapshot owns every exact tool document, so enabled summaries,
invocations, admitted targets, and effect-classification inputs cannot describe
different tool sets. The hook is synchronous and
side-effect-free; a protocol executor refreshes its cached snapshot at its own
I/O boundary rather than making packet assembly perform network discovery.

§executor-tool-document **Tool documents are the model-facing executor
directory.** A general runtime's document carries exact H2 `Summary` and
`Invocation` sections plus its executable witness. Its Summary is that compact
invocation witness in inline code, with the authored description as an
operation annotation on its invocation line and a literal `\n` before a
one-line body. An exact registry instead renders one compact family document
whose Summary remains the family description and whose H2 `Invocation`
contains one `plurnk` fence with
every exact annotated EXEC heading and signature, plus one child document per
tool. Each child's Summary is its annotated invocation form; its H2 `Invocation`
contains the literal target, signature, and supplemental input details.
Supplemental `details` follows framework-owned sections and cannot own identity,
invocation, or admission. The consumer chooses resource addresses, materializes
the documents, and exposes each Summary through ordinary FIND metadata. No
executor table or executor-specific discovery protocol exists.

Runtime-name admission is one identity contract:

| Constraint  | Contract                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Syntax      | `[a-z][a-z0-9+.-]*`: canonical lowercase RFC-scheme syntax that is also an admitted EXEC identifier.           |
| Identity    | The exact name is the EXEC selector, registry key, tool-family identity, and output URI-scheme name.           |
| Reservation | `only` is unavailable because `PLURNK_EXECS_ONLY` owns that case-insensitive configuration key.               |

Installed static declarations, trusted dynamic-hook declarations, and
module-owned declarations use the same validator before detail lookup,
policy filtering, or registry mutation. A malformed claimed declaration fails
hard and names its package or module boundary; discovery still ignores an
unreadable package that never forms an executor manifest.

### §executor-dynamic-runtimes Dynamic declarations

A trusted package whose tags depend on deployment configuration may declare
`plurnk.runtimesModule` as an exported subpath instead of a static
`plurnk.runtimes[]` array. Its named `runtimes` export, or default export,
returns `RuntimeDecl[] | Promise<RuntimeDecl[]>`. Static declarations win when
both fields are present.

Discovery resolves the subpath through the package export map and imports it
only after the trust gate. An unloadable hook, missing function export, thrown
hook, or non-array result is a fail-hard contract violation by the admitted
package. The hook enumerates configuration; reachability remains the per-tag
probe's job.

### §executor-trust Trust precedes executable discovery hooks

The shared plugin trust predicate runs before a dynamic runtime module is
imported. A withheld package executes no hook and is returned in
`Discovery.skipped` for consumer presentation. Discovery silently ignores a
package that does not form a readable executor manifest; once an admitted
package declares executable hook code, its broken hook is surfaced rather than
swallowed.

### §executor-policy Subtractive runtime policy

Discovery applies the daemon's registration policy to every tag. The exported
`Policy` parser can apply the same grammar to additional consumer-owned layers.

| Variable                                 | Enforced effect                                             |
| ---------------------------------------- | ----------------------------------------------------------- |
| `PLURNK_EXECS_<TAG>=0` or `false`        | Remove that tag. Keys are matched case-insensitively.       |
| `PLURNK_EXECS_ONLY=<list>`               | When present, remove every unlisted tag; empty removes all. |
| `Policy.isKey(key)`                      | Admit only `ONLY` or a canonical runtime-tag suffix.        |
| `Policy.enabledAcross(tag, [a, b, ...])` | Keep the tag only when every supplied layer enables it.     |

Policy is purely subtractive: no layer can re-enable a tag removed by another.
Boot-disabled tags are absent from the registry and returned in
`Discovery.disabled`. Workspace and loop admission remain consumer concerns;
the framework does not define a second Active/Available state machine.

### §executor-advertise-compat Frozen `Advertise` compatibility

| Surface                              | 1.x contract                                                                                                |
|--------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `Advertise.contribute(registry, fn)` | Filters the supplied registry; returns `NO_EXECS_NOTICE` only when the filtered result is empty.            |
| Architectural ownership             | None. It does not discover, probe, admit, dispatch, or render; the composed service never calls it.         |
| Evolution                            | Frozen. New consumers compose discovery and `Policy` with their own presentation. Removal is SemVer-major. |

## §executor-default-inventory Current installed set

The default `@plurnk/plurnk-service` composition installs the following
`@plurnk/plurnk-execs-<leaf>` packages. The lean framework owns no leaf
dependency edges. A probe and consumer policy still determine which declared
tags are offered in a particular workspace ({§bundled-set}).

| Leaf     | Declared tags                                                                                              | Effect by target                | Channels / mimetype                |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------- |
| `common` | `sh`, `bash`, `node`, `python`, `python3`, `perl`, `ruby`, `php`, `lua`, `deno`, `bun`, `tcl`, `bc`, `awk` | `host`                          | `stdout`, `stderr` / `text/stream` |
| `git`    | `git`                                                                                                      | `host`                          | `stdout`, `stderr` / `text/stream` |
| `jq`     | `jq`                                                                                                       | no target `pure`; target `read` | `results` / `application/jsonl`    |
| `sqlite` | `sqlite`                                                                                                   | memory `pure`; file `host`      | `results` / `application/json`     |
| `wasm`   | `wat`, `wasm`                                                                                              | no target `pure`; file `read`   | `results` / `application/json`     |

Optional executor packages are not part of this installed set merely because
they exist in the workspace.

## §executor-subprocess Subprocess contract

`SubprocessExecutor` translates a runtime, body, and optional target into:

```ts
interface SpawnArgs {
    cmd: string;
    args: string[];
    useShell: boolean;
    stdin?: string;
}
```

### §executor-subprocess-routing Default routing

| Runtime                    | No-target spawn                                                      |
| -------------------------- | -------------------------------------------------------------------- |
| `sh` / `bash`              | Shell command line.                                                  |
| `node`                     | `node -e <body>`.                                                    |
| `python` / `python3`       | `python3 -c <body>`.                                                 |
| Other default-base runtime | `<runtime> -c <body>`; specialized leaves override this fallback.    |

With a target, the target is the program and the body is its stdin. Core
routes a local directory to `cwd` only when that runtime's invocation
declaration opts into the directory rule; every other target remains the
executor target. Data runtimes define their own declared target kind and role.

Subprocess leaves inherit stdout/stderr streaming, scoped-environment handoff,
availability probing, operation results, exit code, and process-group
cancellation. `CommandSyntaxError` during spawn translation becomes a durable
400 `invalid-command`; other translation exceptions remain plugin contract
violations for the consumer to contain.

### §executor-cancellation Cancellation and consumer timing

Executors know only the supplied `AbortSignal`. Core owns EXEC timeout and poll
syntax, timers, wakes, and loop lifetime in {§exec-timeout} and {§exec-poll}.
Subprocess cancellation signals the process group: a caller-supplied kill code
is delivered once; ordinary cancellation uses SIGHUP; loop-end housekeeping
may escalate after the consumer-provided grace period.

## §executor-consumer-boundary Required composition

The consumer:

1. discovers declared tags, instantiates and probes each tag, and caches the verdict;
2. registers a derived output scheme for every admitted, available tag;
3. resolves EXEC to exactly one tag and obtains its effect fact;
4. applies proposal policy, creates the stream entry, and supplies sinks plus cancellation;
5. validates the terminal result and closes every declared channel and subscription coherently; and
6. projects stream observations and later reads without calling back into the executor.

## §executor-forbidden Forbidden in executor leaves

- Direct database, subscription, packet, or wake access.
- Imports from `@plurnk/plurnk-service/*`.
- Mutation of `ExecArgs` or state retained across runs.
- Output through `console.*` instead of declared channels.
- Writes or state transitions for undeclared channels.
- Ignoring `args.signal` at a cancellable boundary.
- A process or network mechanism unrelated to the leaf's declared runtime domain.
