# plurnk-service — Architecture: the agent OS

The framing that keeps us honest. `SPEC.md` is the contract; `AGENTS.md` is the process; this file is the **stance**: what plurnk *is*, so every problem routes to its solved-problem home instead of being re-derived at the prompt.

## The thesis

**The model is the CPU. Plurnk is the OS.** A local model is a slow, non-deterministic, small-context core. What makes a slow CPU run real software is not a smarter CPU — it is a real operating system beneath it: memory it does not manage, scheduling it does not do, structured concurrency, a filesystem, deterministic error recovery. Every capability moved **out of the model and into the deterministic substrate** is one the model no longer has to be smart enough to do. That offload *is* the recovery-rails vision — the moat is the kernel, not the prompt.

So the engineering question is never "how do we get the model to do X." It is **"which subsystem owns X, and what does its decades of theory already say."** Be an OS on purpose, citing the literature. Building an OS *accidentally* — re-deriving paging, concurrency, filesystems one case at a time — is the tar pit that swallows armies. Building one *deliberately* is a solved problem wearing an agent's face.

**And it is time to stop calling it an analogy.** A metaphor that merely illuminates is optional; this one has *dictated every correct decision*. The topo deadlock dissolved into fork-join; the context crisis into demand paging; the terminal contract into `waitpid`; the module boundary into the driver model. A framing that keeps *being* the right answer is no longer a comparison — it is a recognition. **Plurnk is an operating system** — for a new class of CPU: a slow, stochastic, *teachable* one. We build it as such, without hedging: everything a kernel does for a processor that cannot be trusted to do those things itself.

## The Rosetta stone

| Plurnk component | OS analogue | Theory to reach for first | Current locus |
|---|---|---|---|
| The model's per-turn decode | The CPU — a slow, unreliable core | (it's the workload; the goal is to *demand less of it*) | providers |
| The **packet** | The process address space — the state the CPU sees each cycle | Working-set theory; context as addressable state | `PacketBuilder`, `packet-wire` |
| The **budget grinder** (fold under a fixed window) | Virtual memory — demand paging / swap | Denning's working-set model; page replacement (LRU/eviction). FOLD = page-out; KILL = `free()` | `PacketBuilder.enforceBudget`, §grinder |
| The **entry substrate** (`known://`, path-keyed, mutable, FTS+embeddings) | Filesystem + index | VFS, path resolution, content-addressing; inverted index / IR | `_entry-*`, Z4 |
| **Schemes** (known/run/log/exec/http behind one op algebra) | VFS + driver/mount model | "Everything is a file"; uniform driver interface; mount table | `SchemeRegistry`, `schemes/*` |
| **Ops** (FIND/READ/EDIT/OPEN/FOLD/KILL/WORK/SEND) | Syscalls / the ABI | Syscall/ABI design; capability-based access | `Dispatcher` |
| The **matcher** (source-agnostic content dialects) | The query layer over the FS | IR; query planning; parser/dialect design | `Matcher`, §find-source-agnostic |
| **Runs / loops / workers** | Processes / threads | Process & thread model | `runs`/`loops`/`turns` |
| **WORK + park-on-child + wake-edge** | **Fork-join / structured concurrency** | Structured concurrency (Nathaniel Smith; Sústrik); join semantics; **lost-wakeup / owed-wake** | §run-lifecycle, Daemon join |
| The **daemon drain** (which loop runs next) | The scheduler | Run queues; fairness; cooperative scheduling; liveness | `Daemon` |
| **Strikes / cycle detection / maxTurns / hard-413** | Watchdog + liveness enforcement | Safety vs liveness; watchdog timers; livelock/cycle detection; deadlock avoidance | `StrikeRail`, §grinder |
| The **log** (append-only, coordinate-addressed, immutable) | Journal / WAL / audit log | Write-ahead logging; event sourcing; append-only journaling | `log_entries`, `Log` |
| **Streams** (exec, http) | Pipes / async I/O / IPC | Pipes; backpressure; epoll/async I/O | `ChannelWrite`, stream schemes |
| **Wake / cancel / kill / strike** | Signals | Signal delivery; cooperative cancellation | `WakeRun*`, `CancelRun` |
| **Writer authority / packet trust split** | Protection rings / privilege separation | Access control; trust boundaries; taint tracking | packet system/user split |
| The **error channel** (errno-style, self-explaining rows) | `errno` / structured error returns | Fail-fast; error-return conventions | §log-row-self-explains |
| **GBNF grammar constraint** | The ISA — instruction validity on the CPU's output | Grammar-constrained decoding; a type system for emissions | §gbnf-per-alias |
| **Membership** (git `ls-files`, fail-closed) | The FS permission / mount boundary | ACLs; mount namespaces; fail-closed defaults | §membership |
| **MCP hotload / executor registration** | Loadable kernel modules / hotplug | LKMs; dynamic linking; device hotplug | executor-registration seam |
| **agui** — the client-protocol module | The network / protocol-stack driver — in-kernel, faces the wire | Microkernel driver model; trust in-process, validation at the stack's outer edge | `plurnk-agui`, migrating in-process (§Core and its modules) |
| **Budget partition / budget-the-law** | Resource quotas / cgroups | Resource accounting; quotas | §tokenomics-window-partition |
| **Policy** (`~/.plurnk/AGENTS.md`, project AGENTS) | Config / init / policy layer | Policy–mechanism separation | §system-policy |
| **Recovery rails** (deterministic) | Fault tolerance | Deterministic / fault-tolerant systems — the raison d'être | (the whole system) |

## Core and its modules

The Rosetta stone maps *subsystems*; this maps *composition*. An OS is a small protected kernel, surrounded by drivers, faced by user-space — and plurnk is built the same way, on purpose:

```
{ grammar, docs }  →  service { execs · mimes · schemes · providers · agui }  →  { cli/tui, nvim }
   the ISA + canon         core (the kernel) + its daughter modules                user-space clients
```

**Core is the kernel, and we keep it that way deliberately.** Two things are true at once: core owns too much complexity, *and* core works. The discipline that follows is not "gut core to simplify it" — it is **protect a complex-but-working core by pushing new complexity outward, into daughter modules behind uniform seams, never inward.** A driver absorbs a device's quirks so the kernel never learns them; a **daughter module** — execs, mimetypes, schemes, providers, **agui** — absorbs its domain's complexity (a vendor's API, a mimetype's parsing, a wire protocol's rituals) so core never has to. The kernel stays coherent because the complexity lives at the edges, in modules it does not own.

**agui is a daughter module, not an external client — specifically, the protocol/network driver.** It owns the client-facing wire the way a netdev driver owns a link. It runs *in-process*, trusted like execs and schemes: a fault or security boundary between it and core would merely rebuild the socket in software — two trust domains, doubled validation. But it is **singular in exposure** — alone among the daughters it faces *external input*, so it *is* the wall. Peer in trust, singular in exposure: the transport/security perimeter (auth, per-session authorization, schema validation, backpressure) sits at agui's **outer** edge, never between it and core. Exactly a network driver — in-kernel and trusted, and itself the code that sanitizes hostile wire input before it reaches anything else.

**The client interface belongs to the module, not to core.** Core owns the *internals that make agui's job possible* — the engine, the ops, the proposal/pause state, and the in-process seam agui consumes. agui owns *rendering* that state as a client protocol. So the protocols themselves — WebSocket/SSE, AG-UI events, resolve rituals — are documented in **the owning module's** SPEC (plurnk-agui), never here. Core's WebSocket RPC remains its *external* surface for genuinely-external callers; *client interaction* is delegated outward to agui, which is the whole point of the arrangement: **core sheds the client-interface chore and owns less, not more.** The downstream `cli/tui` and `nvim` are user-space — true *customers* of agui's protocol, which is exactly why that perimeter is load-bearing: a client-side agent builds against it knowing nothing of core internals.

## The discipline

1. **Name the subsystem.** When a problem arrives, find its row above before writing anything. "The parent worker got stuck" is not an agent-prompt problem; it is a **scheduling / structured-concurrency** problem.
2. **Apply the theory first.** Fork-join is fifty years old; paging is older. Reach for the solved answer before inventing. The topo failure dissolved the instant we stopped patching and applied concurrency theory.
3. **Offload, don't coach.** The lever is moving capability from the model into the deterministic substrate — not adding words to a message or a prompt to make a weak CPU smarter. Terse signposts + solved mechanism beats verbose teaching every time.
4. **Deviate only where the CPU genuinely differs** (below), and do it deliberately, not accidentally.

## Where this OS is strange — the CPU is unlike silicon

Not where a metaphor cracks — where this OS is *unlike any built before*, because it is built for a processor unlike any before it. These are its defining properties, not its exceptions:

- **The CPU can be *taught*.** Canon (grammar `plurnk.md`) and packet-state can change the workload's behavior — a lever a normal CPU doesn't give you. Use it, but don't *lean* on it: a weak CPU ignores correct teaching (the topo parent saw the park pattern and spin-waited anyway). When teaching is present and ignored, the answer is a deterministic rail, not louder teaching.
- **The CPU is non-deterministic and slow.** So the OS must be *more* robust than a normal one — deterministic recovery isn't a nicety, it's the product.
- **The discipline, worked once — `READ(run://running-child)` is a blocking join** ({§join-blocking-collect}): reading a running child parks the loop until the child terminates (fork-join conformant), so a spin-wait is structurally impossible. The topo strike-out was a parent busy-waiting on a non-blocking try-join; the fix conformed the *primitive* to fork-join theory rather than patching the cycle detector — the template for routing a problem to its subsystem instead of building around the symptom. Liveness rides the existing guarantee (bounded children + join-on-any-terminal + owed-wake).
