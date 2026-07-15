# plurnk-execs — Specification

Contract for `@plurnk/plurnk-execs-*` sibling packages — runtime executors that plurnk-service's `exec://` scheme dispatches to. Audience: implementer of a runtime executor. Consumer: [plurnk-service](https://github.com/plurnk/plurnk-service) (SPEC.md §6.8, §10). Contract shape settled in plurnk-service#174.

**Traceability.** Section tags (`§N`, `§N.M`) are load-bearing: implementation comments cite the governing section, and every non-prose section is pinned by at least one test whose *title* carries its tag (`test("§2.2 probe: …")`). The binding is enforced both directions by `test/spec-coverage.test.ts` — an unpinned section or an orphaned citation fails the suite. Prose-only sections are exempt by an explicit, justified list in that gate.

## §1 Role

A runtime executor handles one or more EXEC `runtime` slot values (`sh`, `node`, `python`, `search`, `news`, …). It is a `BaseExecutor` subclass that declares its output channels and implements `run()`; the framework discovers it from its `package.json` `plurnk` block. The consuming scheme owns all I/O and lifecycle machinery (db, channels, subscriptions, AbortController bridging, wake-on-completion) and hands the executor sinks — the executor stays stateless across runs beyond its construction metadata.

The framework ships `SubprocessExecutor` (§4), the concrete `BaseExecutor` for subprocess runtimes (sh/node/python), built on the lower-level `resolveRuntime` / `SpawnArgs` helper. plurnk-service's exec scheme has adopted `SubprocessExecutor`; the discovery-registry + `probe()`/`effect()` consumption is realized in service `0.9.0` (`ExecutorRegistry` boot-discovers and probes siblings; `EffectPolicy` gates the proposal lifecycle).

## §2 Executor contract

```ts
abstract class BaseExecutor {
    readonly runtime: string;   // matched tag — "sh" / "search" / "news" / …
    readonly glyph: string;
    constructor(metadata: { runtime: string; glyph: string });

    // Channels this executor writes to; the scheme seeds the exec entry from
    // these (§2.1). Subprocess runtimes declare { stdout, stderr }; search
    // declares { results }.
    abstract get channels(): Readonly<Record<string, ChannelDecl>>;

    abstract run(args: ExecArgs): Promise<ExecResult>;
}

interface ChannelDecl { mimetype: string; defaultState?: ChannelState; }
type ChannelState = "active" | "closed" | "errored";

interface ExecArgs {
    runtime: string;            // matched tag; multi-tag executors branch on it
    command: string;            // EXEC body: shell line / source / search query
    cwd: string | null;         // process working dir (session workspace); null for logical runtimes
    target: string | null;      // parsed EXEC (target) slot, interpreted per-runtime (data: input+body=program / executable: program+body=stdin); resolved vs cwd; null if none
    env?: NodeJS.ProcessEnv;    // consumer-scoped child env — drops plurnk's own secrets (plurnk-execs#8); host env inherited when omitted
    signal: AbortSignal;        // cancellation — executors must honor it
    write: (channel: string, chunk: string, mimetype?: string) => void;  // write a chunk; optional mimetype stamps the channel's real per-call output type
    setState: (channel: string, state: ChannelState) => void;            // drive a declared channel's lifecycle
    emit: (event: TelemetryEvent) => void;                               // emit telemetry/error (§2.2)
    entry?: (path: string, content: string, opts: { tags: string[]; mimetype: string }) => Promise<void>;  // request substrate materialization — optional sink (§2.6)
}

interface ExecResult {
    status: number;             // 200 ok / 499 aborted / 500 error
    exitCode?: number;          // subprocess family only
}
```

`run()` must not throw for an expected runtime failure: surface it through `emit` + an `errored` channel state + a non-200 `status`.

### §2.1 Channel topology is executor-declared

The executor declares its channels; the consuming scheme seeds the exec entry from `executor.channels` rather than from a static scheme-level manifest (plurnk-service#174 Q1). This keeps channel names honest — `search` exposes `{ results: { mimetype: "application/json" } }`, and the model reads `exec://<coord>/EXEC#results` instead of an overloaded `#stdout`. `write` / `setState` are generic over channel name; writing to an undeclared channel is a contract violation.

### §2.2 Availability probe

```ts
interface RuntimeAvailability { available: boolean; detail?: string; }

abstract class BaseExecutor {
    async probe(signal?: AbortSignal): Promise<RuntimeAvailability> { return { available: true }; }  // default: available
}
```

`probe()` reports whether the runtime's *environment* is usable here — distinct from whether the *package* is installed (`discover()`). Pure / in-process runtimes (node, sqlite) inherit the available default; runtimes depending on an external binary (`python` → `python3 --version`) or config (`search` → `SEARXNG_URL`) override. `SubprocessExecutor` probes its `binary` getter (`null` = always available).

Consumer contract (plurnk-service#181): probe **once at boot, per package** (not per tag — stamp all of a package's tags with the one result), **concurrently under a per-probe timeout**, and **cache**. The per-probe deadline/cancellation is delivered as the optional **`signal`** — a probe that spawns a child or opens a connection MUST hand `signal` to it, so a resolved or timed-out probe **reaps** it immediately (else an in-flight `--version` write can `EPIPE` after host teardown, plurnk-execs#16). `signal` is ignore-safe: a probe that spawns nothing needs nothing. `probe()` MAY reject; the consumer treats rejection as `{ available: false, detail: <error> }`, so a buggy probe degrades only its runtime. The model is offered a positive list of available runtimes; an attempt at an unavailable one returns **501 carrying `detail`** (so `detail` is model-facing — terse and actionable). A configured default runtime that probes unavailable is a **fail-hard boot error**.

### §2.3 Effect (proposal gating)

```ts
type Effect = "pure" | "read" | "host";

abstract class BaseExecutor {
    effect(target: string | null): Effect { return "host"; }  // default: conservative
}
```

`effect()` classifies an invocation's side effect so the consumer can gate the proposal lifecycle per runtime (service#182). The executor declares the **fact**; the consumer owns the **policy** (an `effect → propose/auto` map, deployment-tunable: default `host → propose`, `read`/`pure → auto`).

- **`host`** — runs code / mutates the host (subprocess; file-backed sqlite) → propose.
- **`read`** — observes external state, no host mutation (search) → auto.
- **`pure`** — no observable side effect (sqlite `:memory:`, transforms) → auto.

`effect()` MUST be **pure, synchronous, and cheap** — it runs on the dispatch hot path at propose time. It classifies the **target only** (known pre-`run()`); it MUST NOT inspect the command (parsing SQL/shell to judge intent is a sandbox-escape footgun) and MUST NOT do I/O. Default `host` is conservative — anything unclassifiable is proposed (fail-safe, the mirror of `probe()`'s fail-open default).

For `exec`, per-runtime `effect()` supersedes the static `Exec.manifest.flags.proposes`. Auto-run (`read`/`pure`) runtimes may run **inline** — synchronous return rather than entry-then-read-next-turn — while still landing the result as a re-readable entry.

### §2.4 Telemetry

Runtime failures are emitted as a grammar `TelemetryEvent` via the `emit` sink (plurnk-service#174 Q3); the scheme routes it to the engine's telemetry buffer — the same path grammar's `parse_error` takes. Events are not encoded into `stderr` (that pollutes program output) nor returned on `ExecResult` (that loses mid-run events).

- `source`: `"exec:<runtime>"` (e.g. `"exec:search"`) or `"scheme:exec"`.
- `kind`: producer-minted, open vocabulary. What the shipped executors actually emit: `SubprocessExecutor` → `spawn_failed` (a failed *start*; a nonzero exit is the program's own result and stays on `stderr`, **not** telemetered); search → `searxng_not_configured` / `searxng_unreachable` / `searxng_timeout` / `searxng_http_<n>` / `external_bang_refused`; sqlite → `sqlite_open_failed` / `sqlite_error`. A cancellation (`signal` abort) is normal flow — **not** emitted.
- `message`: terse, factual. `position`: typically null at the runtime layer.

The envelope is mirrored locally (`TelemetryEvent`, `ContentOffset`, `LogCoordinate`) so the framework needs no `@plurnk/plurnk-grammar` dependency; grammar's `dist/schema/TelemetryEvent.json` is the source of truth.

### §2.5 Deadlines & polling — the executor stays oblivious

An EXEC op may carry a `<L>` line-marker slot read as `[TIMEOUT_SECONDS, POLL_SECONDS?]` (plurnk-grammar#39, plurnk-service#277): `<1800>` hard-kills at 1800s, `<-1>` declines a per-exec deadline (still loop-life bounded), `<1800,300>` adds a 300s loop-poll. **None of this touches the executor contract.** `run()` stays stream-only and abort-driven:

- The **timeout** is the consumer's: at the deadline it fires `args.signal` — arriving as an ordinary abort the executor already honors (the §4 process-group SIGHUP→grace→KILL path). No deadline awareness in the executor.
- The **poll** is purely the consumer's loop: it wakes on a cadence while the channel is `active`, reading the partial output the executor already streams incrementally via `write`. The executor never sees a tick; it's non-destructive.

So the feature is contract-free for executors and applies to all of them uniformly: a long-runner is bounded/watched by the op slot, a fast/logical executor (search) terminates before the first tick and the slot is a no-op.

### §2.6 Output addressing — the executor produces, the consumer reads

An executor is a **producer, not a reader.** Its whole output contract is `run()` writing channels (`write` / `setState` / `emit`); the consumer streams those into an ordinary log entry addressed at **`<tag>://<coord>`** (the run's `<runtime>:///<loop>/<turn>/<seq>`), and every READ/FIND over that output is the consumer's uniform entry machinery — identical for `sh`, `search`, `sqlite`, and MCP alike. The executor never reads, slices, summarizes, or orients its own output.

The executor's only scheme-facing contribution is a **derived manifest** — `OutputScheme.manifestFromRuntime({ name, glyph, channels, defaultChannel })`, built from the runtime declaration, no separate authoring — so the consumer can mint a per-tag output scheme (name = the tag) and the model can address `<tag>://`. `defaultChannel` (first declared channel; subprocess → `stdout`) is where a bare `READ <tag>://<coord>` lands. `discover()` is unchanged (static install/config truth, §3); activation (§3.2) is the consumer's runtime overlay.

**No executor read-face; no per-runtime read, no orientation receipt.** `BaseExecutor` implements no `read`/`find`, and none is wired downstream — not one sibling in the family overrides them (the "rich" `sqlite`/MCP included), and the consumer's per-tag scheme serves every READ through its single `DefaultRead` resolver (which holds the `Mimetypes` instance + output store the executor never sees) over the stored entry. Orientation is **model-pulled**: the model probes an output's shape by querying the entry (FIND / READ with jsonpath / glob / line-range) against the neutral `{ mimetype, tokens, lines }` every entry carries, pulling only the slice it wants. An engine-pushed shape digest *is* the catalog-as-index the paradigm forbids ("the instant it did, it would be an index again") — so there is none, and the answer to service#240's *"where is the OrientIndex receipt built?"* is **nowhere; nothing builds one.** A `<tag>://` entry is folded by default, so output never floods context regardless; the one real risk — a chatty runtime filling sqlite — is a daemon storage-cap concern, not an executor one.

MCP is the proof, not the exception: `plurnk-execs-mcp` is a plain producer — `run()` calls the tool and writes its JSON result to a `results` channel, exactly as `search` writes `results` — with no `read`, no `find`, no summary. Bring a need and it maps onto the log; the log paradigm already orients, and the executor never curates.

**Entry materialization is a sink, not a substrate breach (execs#18 / service#340).** `ExecArgs.entry?(path, content, { tags, mimetype }) → Promise<void>` lets an executor *request* that the consumer materialize a substrate entry — the same shape as `write`/`emit` (consumer-implemented callbacks; the executor never touches storage, tagging, or announcement machinery). The consumer creates the entry, applies the tags, and announces it through its ambience as a **folded** row (the meta line carries path + tokens; page-scale bodies never ride a wake packet). Consumer collision semantics: upsert content, union tags, bump freshness. A rejected `entry()` means *not materialized* — the requesting executor must treat that item as failed (search prunes its digest row). The sink is optional: absent, producers degrade gracefully (search emits its digest without materializing). This closed the gap that §2.6's earlier absolutism forced on the search flow (a double-fetch dance routed around the missing sink); the principle — executors own zero substrate machinery — is unchanged.

**The search dead-row seam resolves here (execs#18 hub's "open specifics" are stale — this supersedes them).** The consumer implements `entry()` *as* the auto-prefetch: fetch, render, materialize the `https://` entry — so its resolve/reject **is** the liveness verdict, and the executor prunes the failed digest row (per the pruning rule above). The digest emitted is survivors-only in a **single pass**: no executor pre-validation (that would fetch — forbidden), no consumer post-filter of a candidate list, no double fetch. A URL prefetch carries no page body for the executor to supply, so `content` is **consumer-sourced** — the executor contributes the candidate `url` as `path` and the consumer derives the body from it; the executor learns liveness only through the verdict, never by reading.

## §3 Discovery

`discover(options?) → { registry, skipped, disabled }`. Scans **every installed package** under the nearest `node_modules` (walking up from `cwd` for workspace hoisting) — scope-agnostic (scoped and unscoped) — for those declaring `plurnk.kind === "exec"`, and registers each runtime tag from `plurnk.runtimes[]`. The scan is deliberately not limited to `@plurnk/*`: a **third party** can publish an executor under their own scope (`@acme/acme-execs-foo`) and have it discovered with no involvement from this project. (No aggregator package: the default bundle is the daemon's own dependency list, not a metapackage.)

```json
{
    "name": "@plurnk/plurnk-execs-search",
    "plurnk": {
        "kind": "exec",
        "runtimes": [
            { "name": "search", "glyph": "🔎", "example": "<<EXEC[search]:france population:EXEC", "documentation": "# search\n\n`!bang` / `:lang` ride the query…" },
            { "name": "news",   "glyph": "📰" }
        ]
    }
}
```

A package may claim multiple tags backed by one handler. Tags form a **flat global namespace**; `registry` maps tag → `{ runtime, glyph, example, documentation, packageName, attribution? }`. Unlike plurnk-mimetypes (last-loaded wins), a tag **collision is fail-hard**: two packages claiming the same runtime is an unresolvable install ambiguity the operator must fix.

Each entry's optional **`attribution`** is the package's raw `plurnk.attribution` (`string | string[]`) — credit a consumer unions onto the model call when the package's tags are active (plurnk-service#249). It's **package-level** (every tag of a package carries the same value) and surfaced **raw**: the consumer owns the reservation policy (e.g. `@plurnk/`-scoped attribution only from `@plurnk/`-scoped packages). `undefined` when the package omits it.

Each entry's optional **`example`** is a one-line, self-documenting usage example surfaced **verbatim** by the consumer in its `# Plurnk System Tools` capability sheet so the model learns the tag's syntax + purpose in one line instead of a separate prose description (plurnk-execs#7). It MUST be the **complete canonical op, `<<`-delimited** — `<<EXEC[tag]:body:EXEC` (or `<<EXEC[tag](target):body:EXEC`) — because the consumer renders it verbatim into the sheet; an example missing the `<<` opener teaches the model a malformed op. Defaults to `""` when omitted. Kept to a single line on purpose — the sheet is hot-path and token-sensitive; the generic `(target)` slot is documented once at the op level, not repeated per tag.

Each entry's optional **`documentation`** is full markdown — the flags, modes, and gotchas the one-liner can't carry. It is the depth a consumer can serve on demand, separate from the always-on `example` (progressive disclosure). The **source of truth is a `docs/<tag>.md` file** in the package (the docs convention; ship it via `files`), which `discover()` reads into `documentation`; the inline `documentation` manifest field is the fallback when no file ships. Defaults to `""`. The execs contract is the two fields; **how** the consumer surfaces them to the model — an in-context one-liner, the full doc fetched when the model wants it — is the consumer's (plurnk-service's) concern, not specified here.

### §3.1 Dynamic runtimes (per-deployment tags)

A package whose tags are not known at publish time — the MCP bridge is the motivating case, where each tag is a per-deployment MCP **server** an operator configures in the environment (plurnk-execs#10) — declares **`plurnk.runtimesModule`** (an export subpath, resolved through the package's export map) **instead of** a static `plurnk.runtimes[]`:

```json
{
    "name": "@plurnk/plurnk-execs-mcp",
    "plurnk": { "kind": "exec", "runtimesModule": "./runtimes" }
}
```

The module's **`runtimes`** export (or its default export) is a hook `() => RuntimeDecl[] | Promise<RuntimeDecl[]>` returning the same decls a static manifest would (`{ name, glyph?, example?, documentation? }`). `discover()` imports and calls it at scan time and registers the result exactly as if the decls were static (a `docs/<tag>.md` file still wins over an inline `documentation`, though dynamic tags rarely ship one). The hook reads its own config from the environment — it must be cheap and **must not** depend on network reachability (that is `probe()`'s job, per server, at boot).

Two guarantees frame the hook:

- **Trust-gated execution.** The hook is imported **only for trusted packages** — the `PLURNK_PLUGINS_TRUSTED_ONLY` gate (below) runs *before* the import, so an untrusted package's code is never executed. This is the same in-process-trust posture executors already carry (their `run()` is trusted host code); dynamic discovery just extends it to scan time.
- **Fail-hard on a broken hook.** An unloadable module, a missing/non-function export, or a non-array return is a **contract violation by a trusted package** (its own packaging or config) and throws with the cause attached — surfaced, not swallowed. This is deliberately stricter than a malformed third-party `package.json`, which `discover()` silently skips: a package that *declares* a hook owns making it work.

`runtimes[]` and `runtimesModule` are mutually exclusive; if both are present the **static array wins** and the hook is never loaded.

**Trust gate.** `discover()` honors the host's **`PLURNK_PLUGINS_TRUSTED_ONLY`** env var (plurnk-service#229) — the one posture decided once and enforced across every scope-agnostic discovery surface (schemes/mimetypes/providers/execs). Unset/`""`/`0` → off: every installed package registers (no regression). Any value → on: `@plurnk/*` is always trusted, plus a comma-separated allowlist of additionally-trusted package names (`1` = on with zero third-party). An untrusted package is **discovered but not registered** — never a crash — and returned in **`Discovery.skipped`** (package names) so the consumer can emit a telemetry note (`discover()` has no sink of its own). The trust predicate is the single shared implementation in **`@plurnk/plurnk-meta`** (`Meta.isTrusted`), consumed identically by the daemon and every family-head scanner — trust is defined once for the whole family, never duplicated.

Each runtime package's **default export** is its `BaseExecutor` subclass (also a named export — `export { default as Sh }` / `export { default }`); the consumer instantiates it per matched tag with the tag + glyph from the registry.

### §3.2 Activation (Active / Available)

Discovery answers *what is installed/configured*; **activation** answers *what is offered to the model right now*. They are distinct axes and must not be conflated — `discover()` stays static truth, activation is a runtime overlay the consumer owns on top of it (plurnk-execs#10). This generalizes across the **shared exec/scheme namespace**: a registered capability is a tag claimed once that is both `EXEC[tag]` and `tag://`, and activation operates on it whichever family it came from. MCP is not a category here — it is one *route* for registering a capability (alongside package discovery and env), so its tags activate by the same rules as any other.

**Two states, no third.** A registered capability is **Active** (in the `# Plurnk System Tools` sheet, dispatchable) or **Available** (registered, inert). "Disabled" is the *verb* (Active→Available), not a state. The consumer's capability sheet surfaces two buckets:

- **Tools Active** — the full one-line `example` each (the hot-path teaching cost).
- **Tools Available** — name + glyph + `attribution` each (a word, not a line).

This split *is* the progressive disclosure that bounds the sheet: N available servers cost N words, not N lines.

**Default-activation rule** (the consumer applies it; execs supplies the signals — `packageName` scope, source route, `attribution`):

| Source route | Trust | Default |
|---|---|---|
| Installed package (boot discovery) | first-party (`@plurnk/*`) | **Active** |
| Installed package (boot discovery) | third-party | **Available** |
| Env-declared (e.g. `PLURNK_EXECS_MCP_<server>`, model-alias style) | — | **Available** |
| Runtime hotload (`/mcp`, gated — below) | — | **Active** on add |

The principle: *Active = the operator unambiguously committed this capability ON* (installed a first-party package; explicitly hotloaded). Configuring connection details (env) or installing a third-party package is the lighter act → Available, opt-in. Mirrors `PLURNK_MODEL_*` — declare many aliases, activate a subset.

**Reachability is orthogonal.** Whether a capability is Active/Available (activation) is independent of whether it is reachable/unreachable (the §2.2 `probe()` health flag). A configured MCP server that is down is *Available but unreachable*. Do not overload "available" across the two axes.

**Capability vs substrate.** enable/disable targets **capability** tags only (execs and executor-backed schemes). Core **substrate** schemes (`file://`, the addressing/ops ground) are always-active and never toggleable — `/disable file` must not be able to brick the address space. For an executor-backed scheme, `disable` gates *new production*; existing `tag://` entries stay READable (reads are pure).

**Security — one gate, on introduction not activation.** `enable` / `disable` are **not** trust-gated: a client (and the model itself) may freely activate any *registered* capability. This is safe because the registered set is operator-bounded — only env-declared or package-installed capabilities exist — *unless* the single daemon gate **`PLURNK_EXECS_MCP_INSTALL`** (default off) opens the runtime-hotload route, permitting *arbitrary* tooling to be **added**. Gate the introduction of capabilities, never their activation. The trust gate (§3) still bounds *registration*; activation rides on top of an already-trusted set.

Execs owns none of the overlay machinery — the live Active/Available state, the `/enable` `/disable` `/mcp` commands, and the gate enforcement are the consumer's (plurnk-service#240). Execs' contribution is the static signals above and (for the hotload route) an MCP executor that accepts a runtime-injected server config and re-checks `PLURNK_EXECS_MCP_INSTALL` at its connect path (defense in depth).

### §3.3 Runtime policy (the enable/disable cascade)

A **registration** bound — a sibling of the §3 trust gate, **not** the §3.2 activation overlay. The trust gate bounds registration by *package*; the runtime policy bounds it by *tag*; `discover()` enforces both (the two operator gates on "what is registered for this daemon"). A policy-disabled tag is **absent** — not Active, not Available — so §3.2's "a client may freely activate any registered capability" still holds: the registered set is simply bounded per layer.

**Grammar** (the `PLURNK_EXECS_*` namespace, identical at every tier):

| Var | Effect |
|---|---|
| `PLURNK_EXECS_<TAG>=0` (or `false`) | surgical kill-switch for one tag |
| `PLURNK_EXECS_ONLY=a,b,c` | allowlist — a tag not listed is disabled |

The two compose within a layer (an allowlisted tag can still be individually killed). `ONLY` is reserved: a runtime tag may not be named `only`. **Keys are matched case-insensitively** — `PLURNK_EXECS_sh=0` ≡ `PLURNK_EXECS_SH=0`, the way the mcp config folds server names, so the natural lowercase-tag spelling doesn't silently no-op. Purely **subtractive** — there is no force-enable verb, by design.

**The cascade is an intersection.** A tag is live iff enabled in *every* layer: `enabled(tag) = service ∧ client ∧ …`. Because each layer only subtracts, order is irrelevant and no downstream layer can undo an upstream disable — **the client can never re-enable what the service disabled**, structurally, not by a policed rule.

- `discover()` applies the **daemon boot layer** (`process.env`) at registration, uniformly across every daughter (framework-guaranteed — a daughter cannot escape it, the way `-common`'s old local kill-switch let `sqlite`/`jq`/`git` slip through). Disabled tags are returned in `Discovery.disabled`.
- The consumer applies the **per-session client layer** with the *same parser* — `Policy.enabledAcross(tag, [serviceEnv, clientLayer])`, or `Policy.isEnabled(tag, clientLayer)` over the already-registered set. The client declares its policy in the identical `PLURNK_EXECS_*` format; the daemon intersects. The client has no enforcement surface of its own — executors run in the daemon — so this is a structural ceiling, not a trust boundary.

Framework surface: **`Policy.isEnabled(tag, env?)`** (one layer, defaults to `process.env`) and **`Policy.enabledAcross(tag, layers)`** (the intersection). To disable all standard execs except search: `PLURNK_EXECS_ONLY=search`.

### §3.4 The empty-set notice (the legible no)

When a loop leaves **zero** EXEC runtimes in the §3.2 *Active* bucket, the capability sheet must carry a positive statement — **"No EXEC operations permitted"** — not silent absence. The grammar still teaches `EXEC` as a valid op (the GBNF permits it); with no availability signal either way, the model reads the bare op mention as *unknown* and confabulates runtimes, burning its strikes on a gate that correctly refuses them (execs#24). The negative line closes that window: a legible *no* where silence invited a guess.

**One contributor, both cases.** `Advertise.contribute(registry, isPermitted)` returns the permitted runtimes **and** the notice from the *same* filter — a non-empty result never carries a notice, so the N-runtime sheet and the 0-runtime line cannot drift out of sync.

**Cause-agnostic.** `isPermitted` resolves whether a registered tag survives *this* loop's gates: execs supplies the §3.3 policy cascade as the baseline predicate, and the consumer composes stricter gates into it — the effect-typed **host bar** by which a loop mode (ask-mode) bars host-effecting ops. But *why* the set is empty — policy zeroing every tag, or the host bar catching them all — is never execs' business. Execs owns the §2.3 `effect()` classification and the count; the consumer owns the loop-mode decision and reduces it to the effect-typed bar it composes into the predicate. Nothing about the mode reaches execs. The line is short and **EXEC-scoped** — it names the op, so the model reads a bounded "no EXEC here", not a general rule — and cause-agnostic. Exact wording is the consumer's ask-mode probe to validate, not asserted here.

Execs owns the notice content and the tally. It does **not** own the mode, the sheet's rendering, or the decision of when a loop bars host effects — only the single line spoken when its own count of surviving runtimes reaches zero.

## §4 Subprocess helper (legacy path)

`resolveRuntime(runtime, command) → SpawnArgs` and `isKnownRuntime(runtime)` / `KNOWN_RUNTIMES` translate a subprocess runtime tag into `node:child_process.spawn` arguments:

```ts
interface SpawnArgs { cmd: string; args: string[]; useShell: boolean; stdin?: string; }
```

| Runtime | Spawn |
|---|---|
| `""` / `"sh"` / `"bash"` | `{ cmd: command, args: [], useShell: true }` |
| `"node"` | `{ cmd: "node", args: ["-e", command], useShell: false }` |
| `"python"` / `"python3"` | `{ cmd: "python3", args: ["-c", command], useShell: false }` |
| any other | `{ cmd: runtime, args: ["-c", command], useShell: false }` (conservative fallback) |

`resolveRuntime` never throws; consumers gate unknown runtimes with `isKnownRuntime` and return 501 before invoking.

**With a `(target)`** — `resolveRuntime(runtime, command, target)` runs the **target as the program** and the **body as its stdin** (plurnk-execs#15): a shell runs `sh -c "<target>"` (the shell tokenizes the target — the framework parses nothing), any other runtime runs `<interpreter> <target>` (a single script-file positional). No target → the body is the inline program (`-c`/`-e`) as in the table. This is family-relative: the *data* runtimes (jq/sqlite/wasm) invert it — `target` is the data, `body` the program — inside their own `run()`. Each daughter maps the two raw strings to its own tool's CLI; the parent hands them down and parses neither.

The framework wraps this in **`SubprocessExecutor extends BaseExecutor`** — declares `{ stdout, stderr }` channels and implements `run()` (spawn via `resolveRuntime`, stream into the channels, honor `signal`, `emit` `spawn_failed` on a failed start, return `{ status, exitCode }`). Subclasses with their own interpreter table override the **`protected spawnArgs(runtime, command, target) → SpawnArgs`** hook (default delegates to `resolveRuntime`) — and so inherit run()'s streaming + process-group abort handling. `SpawnArgs.stdin?` lets filter-style runtimes feed their program/input via stdin (`bc`, `tclsh`; or `""` for an `awk` BEGIN with EOF). On abort it signals the whole **process group** (`detached` spawn + `process.kill(-pid, …)`) so shell grandchildren can't leak (plurnk-execs#4): the default abort is a polite **SIGHUP**, once, no escalation; a `KILL[code]` reason carrying `{ signal }` delivers exactly that signal, fire-and-forget; only the consumer's loop-end housekeeping reason (`{ housekeeping: true, graceMs }`) escalates SIGHUP→**SIGKILL** after the consumer-sourced grace (never a magic number here). The `plurnk-execs-common` sibling subclasses it — claiming the whole subprocess set (sh/bash/node/python plus detected host interpreters) via a recipe table behind a `spawnArgs()` / `probe()` override. `isKnownRuntime` / `KNOWN_RUNTIMES` are the legacy 501 gate; the discovery registry + `probe()` supersede them once a consumer wires the registry.

## §5 Consumer surface (plurnk-service)

Per plurnk-service#174/#181/#182, realized in service `0.9.0`, the exec scheme:

1. Boot-discovers executors (`discover()`), `probe()`s each per-package, and offers the model the positive available-runtimes list; an unavailable runtime returns 501 carrying `probe()` `detail`.
2. Resolves the runtime tag to its executor and runs it through `run()`, seeding the exec entry's channels from `executor.channels`.
3. Provides the `write` / `setState` / `emit` sinks bound to its channel-write, channel-state, and engine-telemetry machinery; bridges its AbortController to `args.signal`; maps the `ExecResult` to close-status + wake summary.
4. Gates the proposal lifecycle by `effect(target)` (`EffectPolicy`: `host → propose`, `read`/`pure → auto`), running auto-run runtimes inline (synchronous return) while still landing the result as a re-readable entry.

## §6 Forbidden (for siblings)

| ❌ |
|---|
| Database access |
| Imports from `@plurnk/plurnk-service/*` |
| Mutating `ExecArgs` |
| Holding state across `run` calls beyond construction metadata |
| Reading runtime output via `console.*` |
| Ignoring `args.signal` |
| Writing to an undeclared channel |
| Spawning processes outside the runtime's domain (e.g. an HTTP/search runtime spawning subprocesses) |
