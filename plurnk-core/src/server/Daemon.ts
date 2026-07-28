// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the plugin-module seam (#364: the daemon owns no transport).
// SPEC §rpc.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Db } from "../core/Db.ts";
import { execPollBackoffMs } from "./exec-poll-backoff.ts";
import type { ProposalResolution } from "../core/ProposalLifecycle.ts";
import ChannelWrite, { type WakeWorkerPayload } from "../core/ChannelWrite.ts";
import { Paths } from "../index.ts";
import Engine from "../core/Engine.ts";
import ExecutorRegistry from "../core/ExecutorRegistry.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Provider, ProviderAlias } from "@plurnk/plurnk-providers";
// The event scope (#364 — relocated from the retired MethodRegistry): "all" = a global event
// (workspace/created), {workspaceId} = workspace-scoped. "this" retired with the per-connection leg.
export type NotifyTarget = "all" | { workspaceId: number };
// One drained loop's terminal shape — the drain's return currency.
export interface DrainLoopResult { loopId: number; result: SchemeResult; hitMaxTurns: boolean; turnIds: number[]; action?: string; usage?: { promptTokens: number; completionTokens: number; costUsd: number } }
import type { Notice, PlurnkStatement } from "@plurnk/plurnk-grammar";
import LogEntry from "./logEntry.ts";
import type { LogEntryWire } from "./logEntry.ts";
import Envelope from "./envelope.ts";
import ClientInput from "./client-input.ts";
import type { ClientEnvelope } from "./envelope.ts";
import ClientTurn from "./clientTurn.ts";
import LoopDocs from "./loopDocs.ts";
import GitMembership from "../core/git-membership.ts";
import Fork from "../core/fork.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import { promptLoopPrefix } from "../core/plurnk-uri.ts";
import { rulerCount } from "../core/token-ruler.ts";
import type { Executor, RegistryEntry } from "../core/ExecutorRegistry.ts";
import type { RuntimeDecl, RuntimeAvailability } from "@plurnk/plurnk-execs";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopAlias } from "./loop-model.ts";
import Auto from "./auto.ts";
import NoProposals from "./noProposals.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { LoopFlags } from "../core/types.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import BranchBatches from "./BranchBatches.ts";

const clientActionFailure = (error: unknown): SchemeResult =>
    error instanceof OperationFailureError
        ? error.result
        : Results.failure(
            "daemon:client",
            "action-threw",
            500,
            `The client action threw: ${error instanceof Error ? error.message : String(error)}`,
        );

// A stopped-world proposal a transport module renders as a TOOL_CALL (#355 seam read). The raw
// `state='proposed'` row shape (§proposal-list); the module reshapes it at its edge.
export interface PendingProposal {
    logEntryId: number;
    workerId: number;
    loopId: number;
    turnId: number;
    op: string;
    suffix: string;
    scheme: string | null;
    pathname: string | null;
    tx: string | null;
    attrs: string | null;
    at: string;
    loop_flags: string | null;
}

// The entry shape a client renders (#355 readEntry) — all channels + tags + metadata for one path.
export interface ChannelShape { content: string; contentLength: number; mimetype: string; tokens: number; state: string; }
export interface EntryShape {
    id: number;
    scope: string;
    workspaceId: number;
    scheme: string;
    pathname: string;
    channels: Record<string, ChannelShape>;
    tags: string[];
}
type ChannelRow = { name: string } & ChannelShape;

export default class Daemon {
    #db: Db;
    #engine: Engine;
    #workspaceGate: WorkspaceGate;
    #branchBatches: BranchBatches;
    #lifecycle: LoopLifecycle;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #provider: Provider | null;
    #nodeModulesPath: string;
    #discoveryCwd: string;
    #started = false; // start() runs once — boots discovery + plugin modules (#364: no listener, ever)
    // The emit half of the broadcast, exposed as an in-process event source (#355). A transport
    // module (plurnk-agui) subscribes and fans out to its OWN clients; core emits, never owns
    // client transport or connection state.
    #eventSubscribers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();

    // Run-level drain registry. At most one drain per worker. The stored object
    // is the drain's identity handle: start/exit compare it by reference so a
    // drain exiting never clobbers a successor that raced in, and a loop
    // enqueued during teardown is never stranded. A drain is a pure queue
    // consumer (claim → run → exit on empty queue); streams live independently
    // (subscriptions + Exec.idle), and a concluding stream routes through
    // inject() like any other loop source.
    #activeDrains = new Map<number, { controller: AbortController; promise: Promise<unknown> }>();
    // Per-run cancellation scope. Loops AND the streams they spawn (execs)
    // share this signal, so loop.cancel / shutdown abort it once and every
    // in-flight subscription tears down — even a spawn that registers AFTER the
    // cancel self-aborts against the already-aborted signal (no race). Outlives
    // any single (ephemeral) drain; replaced with a fresh controller once
    // aborted so a later loop.run isn't born cancelled.
    #workerAborts = new Map<number, AbortController>();
    // grammar 0.74.20 EXEC `<T,P>` — per-worker hibernation poll-wake timer. When a loop parks at
    // a park with a polled stream, a timer fires every P seconds to resume it (§exec-poll). One
    // per worker (the tightest cadence); cleared/replaced on each park and on cancel.
    #parkTimers: Map<number, NodeJS.Timeout> = new Map();
    #pollTimers = new Map<number, ReturnType<typeof setTimeout>>();
    #pollBackoff = new Map<number, number>(); // #521 — the exec-poll backoff step per worker (nth wake)
    // Per-run drain-transition lock — see #withDrainLock (R4 / §worker-lifecycle-single-drain).
    #drainLocks = new Map<number, Promise<unknown>>();
    // §worker-lifecycle-child-wake — runs OWED a wake: a child/stream conclusion fired while the worker was
    // mid-turn (not yet slept), so #wakeParkedWorker could not resume it. A worker-run conclusion is a
    // BOUNDED, lossless wake (a worker always concludes), so a hibernation awaiting one MUST return —
    // never deadlock. The drain honors the owed wake at the worker's next park, closing the conclude-
    // before-park race. (Only a live exec stream, unbounded absent a timeout, may hold a park open.)
    #owedWakes = new Set<number>();

    constructor({
        db, schemes, mimetypes, provider, nodeModulesPath,
    }: {
        db: Db;
        schemes?: SchemeRegistry;
        mimetypes?: Mimetypes;
        provider?: Provider | null;
        nodeModulesPath?: string;
    }) {
        this.#db = db;
        this.#lifecycle = new LoopLifecycle(db);
        this.#schemes = schemes ?? new SchemeRegistry();
        this.#provider = provider ?? null;
        // Plugin discovery resolves from the SERVICE's node_modules (its exec/scheme/mimetype
        // deps), NOT process.cwd() — else a globally-installed daemon started from a project dir
        // finds no plugins. The bin passes the package-relative path; cwd default holds for
        // in-repo tests. discover() takes a cwd and joins node_modules, so derive the parent.
        this.#nodeModulesPath = nodeModulesPath ?? resolve(process.cwd(), "node_modules");
        this.#discoveryCwd = dirname(this.#nodeModulesPath);
        // Mimetypes owns discovery + detection; default mimetype text/markdown. (Token counting
        // is NOT wired here — the engine's ruler below is §tokenomics-agnostic-ruler.)
        this.#mimetypes = mimetypes ?? new Mimetypes({
            defaultMimetype: "text/markdown",
            discoverOptions: { cwd: this.#discoveryCwd },
        });
        const bootSpec = resolveActiveAlias();
        if (this.#provider !== null && bootSpec !== null) {
            ProviderInstantiate.registerInstance(this.#provider, bootSpec);
        }
        this.#workspaceGate = new WorkspaceGate(async (workerId, rootWorkerId) => {
            const row = await this.#db.branch_batch_worker_lineage.get<{ member: number }>({
                worker_id: workerId,
                root_worker_id: rootWorkerId,
            });
            return row !== undefined;
        });
        this.#branchBatches = new BranchBatches(db, this.#workspaceGate, {
            settleWorkspace: async (workspaceId) => this.#engine.drainWorkspaceDerivations(workspaceId),
            createChild: async ({ workspaceId, parentWorkerId, op, name, prompt, flags, origin }) => {
                const providerSpec = resolveActiveAlias();
                if (providerSpec === null) throw new Error("Branch worker: active provider has no resolvable alias");
                const workerId = op === "FORK"
                    ? await Fork.fork(this.#db, parentWorkerId, name)
                    : (await this.#db.fork_insert_worker.get<{ id: number }>({
                        workspace_id: workspaceId,
                        name,
                        parent_worker_id: parentWorkerId,
                        origin,
                    }))?.id;
                if (workerId === undefined) throw new Error("Branch worker insert returned no row");
                const loopId = await this.#enqueueFreshLoop({
                    workerId,
                    prompt,
                    providerSpec,
                    flags,
                });
                return { workerId, loopId };
            },
            startChild: async (workspaceId, workerId, loopId) => {
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const started = await this.#ensureDrain({ workspaceId, workerId, systemPrompt });
                if (started === null) throw new Error(`Branch worker ${workerId} already has a live drain`);
                const result = await started.firstLoopPromise;
                if (result.loopId !== loopId) {
                    throw new Error(`Branch worker ${workerId} drained loop ${result.loopId}, expected ${loopId}`);
                }
                return result.result;
            },
            wakeParent: async (workspaceId, workerId) => {
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                await this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, false);
            },
            notify: (workspaceId, payload) => {
                this.#broadcast({ workspaceId }, "workspace/branch-batch", payload);
            },
        });
        this.#engine = new Engine({
            db, schemes: this.#schemes, mimetypes: this.#mimetypes,
            // §tokenomics-agnostic-ruler — the ONE model-facing token ruler (chars/2), NOT the
            // boot provider: token accounting is workspace-wide across many concurrent models, so
            // the write-time + catalog counts must be model-independent. Exact per-model counting
            // lives only at the packet-materialization fit-gate.
            tokenize: rulerCount,
            streamEventNotify: (workspaceId, event) => this.notifyStreamEvent(workspaceId, event),
            wakeWorkerNotify: (payload) => { void this.#handleWakeWorker(payload); },
            // worker:// loop-start primitive — spawn/fork/irc deliver through
            // Daemon.inject (active sister → fold; idle → enqueue + drain). The
            // daemon owns provider + the law-file system prompt; the worker scheme
            // handler carries neither. Fire-and-forget: the returned drain runs
            // independently (the sister is its own worker). §machine-processes
            injectWorker: async ({ workspaceId, workerId, prompt, flags }) => {
                if (this.#provider === null) throw new Error("injectWorker: no provider configured");
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const providerSpec = resolveActiveAlias();
                if (providerSpec === null) throw new Error("injectWorker: active provider has no resolvable alias");
                const { action, loopId } = await this.inject({ workspaceId, workerId, prompt, providerSpec, systemPrompt, ...(flags === undefined ? {} : { flags }) });
                return { action, loopId };
            },
            branchWorker: async (args) => this.#branchBatches.enqueue(args),
            branchCompletionGate: async (workerId) => this.#branchBatches.completionGate(workerId),
            acquireWorkspaceTurn: async (workspaceId, workerId) => this.#workspaceGate.acquireTurn(workspaceId, workerId),
            workspaceTurnCompleted: async ({ turnId }) => this.#branchBatches.sealTurn(turnId),
            // worker:// KILL (terminate) — cancel the addressed worker subtree and
            // tear down its held streams before the operation completes.
            cancelWorker: async (workerId, reason) => this.#cancelWorkerTree(workerId, reason),
            cancelDescendants: async (workerId, reason) => this.#cancelTree(workerId, reason, false),
            noticeNotify: (workspaceId, payload) => this.notifyNotice(workspaceId, payload),
        });
        // Wire proposal-pending events to the loop/proposal WS notification.
        // Sessionid scopes the broadcast to clients on the same workspace.
        this.#engine.onProposalPending((event) => {
            this.#broadcast({ workspaceId: event.workspaceId }, "loop/proposal", {
                logEntryId: event.logEntryId,
                workerId: event.workerId,
                loopId: event.loopId,
                turnId: event.turnId,
                op: event.op,
                target: event.target,
                body: event.body,
                attrs: event.attrs,
                // event.flags is carried for discoverability — a client in
                // loop-auto mode (event.flags.auto=true) knows to skip
                // rendering review UI because the entry will resolve in-
                // process before any human can react.
                flags: event.flags,
            });
        });
        // In-tree auto listener resolves proposals when persisted flags.auto is true.
        Auto.attach(this.#engine, this.#db);
        // Inverse policy: auto-REJECT proposals in-process when the loop's
        // persisted flags.noProposals === true (client has no review channel).
        // The model sees an ordinary 400, never the orchestration reason.
        NoProposals.attachNoProposals(this.#engine, this.#db);
    }


    // The client-interface seam (#355). A transport module subscribes to the daemon's in-process
    // event source: it receives every workspace-scoped engine event as `(workspaceId, method, params)`
    // and fans out to its OWN clients — core emits, it never fans out for the module. Returns an
    // unsubscribe. `workspaceId` is the event's workspace, or null for a global event (e.g. workspace/created).
    // The engine and its events are core; the fan-out belongs to the module.
    subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void {
        this.#eventSubscribers.add(handler);
        return () => { this.#eventSubscribers.delete(handler); };
    }

    // The client-interface seam (#355) — proposal HITL. A transport module reads the stopped-world
    // proposals for a workspace (rendering each as a TOOL_CALL) and feeds back the human's decision. The
    // gate, validation, and applyResolution stay core (Engine.resolveProposal); the seam is the read +
    // the resolve, never the mechanism. `resolveProposal` throws for an unknown/already-resolved id.
    async pendingProposals(workspaceId: number): Promise<PendingProposal[]> {
        return this.#db.proposal_list_pending.all<PendingProposal>({ workspace_id: workspaceId });
    }

    resolveProposal(logEntryId: number, resolution: ProposalResolution): void {
        this.#engine.resolveProposal(logEntryId, resolution);
    }

    // The client-interface seam (#355) — drive/steer a loop. The module supplies only workspace/run/prompt;
    // the provider and the law-file system prompt are core's and stay inside. Returns immediately — the
    // loop runs async and its outcome arrives on the event source (loop/terminated). `cancelDrain` (public)
    // is the cancel hook. Both funnel through the unified `inject`, which owns the drain lifecycle.
    async runLoop(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: Partial<LoopFlags>; openPaths?: string[]; alias?: string; model?: string }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        const flags = ClientInput.normalizeLoopFlags("loop.run", args.flags) as Partial<LoopFlags> | undefined;
        // #414 — per-loop model selection: a client sends its alias/model on every loop, so a
        // switch takes effect turn-to-turn. `model` (client-resolved <provider>/<model>, #90) wins
        // over `alias`; neither → the boot default. Instantiation is cached, so ping-ponging
        // between two models is cheap, and an unresolvable alias/model fails loud here.
        const selection = await this.#resolveLoopProvider(args.alias, args.model);
        if (selection === null) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "not-configured",
                501,
                "No provider is configured for this loop.",
            ));
        }
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
        // §machine-processes — the model NEVER runs in a client-origin run (its packets would carry
        // client op.* rows). The module resolves the model worker via ensureModelWorker and passes it (or a
        // fork); a client worker here is a caller error, refused loudly rather than silently rehomed.
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number; origin: string }>({ id: args.workerId });
        if (target === undefined) throw new Error(`runLoop: run ${args.workerId} not found`);
        if (target.origin === "client") throw new Error(`runLoop: run ${args.workerId} is a client worker — loops run in model workers (§machine-processes); resolve one with ensureModelWorker(workspaceId)`);
        // §operator-config-max-turns-ceiling — the operator ceiling clamps a per-call maxTurns; a
        // seam caller must not bypass operator policy (inject only DEFAULTS from env, never clamps).
        const ceiling = Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "-1");
        const requested = args.maxTurns ?? ceiling;
        const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));
        const { flags: _inputFlags, ...rest } = args;
        const { action, loopId, turnSeq } = await this.inject({
            ...rest,
            ...(flags !== undefined ? { flags } : {}),
            maxTurns,
            providerSpec: selection,
            systemPrompt,
        });
        return { status: 100, action, loopId, ...(turnSeq !== undefined ? { turnSeq } : {}) };
    }

    // #414 — resolve a per-loop model override to a Provider (cached instances). `model`
    // (<provider>/<model>, client-resolved #90) wins over a named `alias`; absent both, the
    // boot default. A named alias missing from the env cascade, or a malformed model spec, throws
    // legibly rather than silently running the wrong model.
    async #resolveLoopProvider(alias: string | undefined, model: string | undefined): Promise<ProviderAlias | null> {
        const requested = resolveLoopAlias(alias, model, parseAliasesFromEnv());
        if (requested === null && this.#provider === null) return null;
        const spec = requested ?? resolveActiveAlias();
        if (spec === null) throw new Error("runLoop: boot provider has no resolvable alias");
        // Resolve eagerly so loop.run fails before enqueue when the provider
        // cannot be constructed. The drain later retrieves this cached handle
        // from the loop's durable spec at the claim boundary.
        await ProviderInstantiate.instantiateProvider(spec);
        return spec;
    }

    async #providerSpecForLoop(loopId: number): Promise<ProviderAlias> {
        const row = await this.#db.drain_loop_provider_spec.get<{ provider_spec: string }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loop ${loopId}: provider selection row is missing`);
        let parsed: Partial<ProviderAlias> | null;
        try {
            parsed = JSON.parse(row.provider_spec) as Partial<ProviderAlias> | null;
        } catch {
            throw new Error(`loop ${loopId}: persisted provider selection is malformed — refusing boot-default substitution`);
        }
        if (parsed === null
            || typeof parsed.alias !== "string" || parsed.alias.length === 0
            || typeof parsed.provider !== "string" || parsed.provider.length === 0
            || typeof parsed.model !== "string" || parsed.model.length === 0
            || (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string")) {
            throw new Error(`loop ${loopId}: persisted provider selection is missing or invalid — refusing boot-default substitution`);
        }
        return parsed as ProviderAlias;
    }

    async #providerForLoop(loopId: number): Promise<Provider> {
        return ProviderInstantiate.instantiateProvider(await this.#providerSpecForLoop(loopId));
    }

    async #assertLoopProvider(loopId: number, requested: ProviderAlias): Promise<void> {
        const selected = await this.#providerSpecForLoop(loopId);
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw new Error(
                `loop ${loopId}: provider selection is frozen at '${selected.alias}' (${selected.provider}/${selected.model}); `
                + `requested '${requested.alias}' (${requested.provider}/${requested.model}). `
                + "Cancel or conclude the loop before hot-swapping models.",
            );
        }
    }

    async #assertLoopMaxTurns(loopId: number, requested: number | undefined): Promise<void> {
        if (requested === undefined) return;
        const durable = await this.#db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId });
        if (durable === undefined) throw new Error(`inject: loop ${loopId} has no durable turn ceiling`);
        if (durable.max_turns !== requested) {
            throw new Error(`inject: the prompt would fold into loop ${loopId} with maxTurns ${durable.max_turns}, not requested ${requested} — maxTurns is loop-scoped and immutable; cancel or conclude the loop before opening one with a different ceiling`);
        }
    }

    // §machine-processes — the workspace's model worker (created on first use), distinct from the client
    // run so the model's packets never carry client op.* rows. The module binds its threads to this.
    ensureModelWorker(workspaceId: number): Promise<number> {
        return Envelope.ensureModelWorker(this.#db, workspaceId);
    }

    // The op-dispatch hook (#355) — execute one parsed op on behalf of a client: journaled as a
    // client-origin turn (the log is core's, a client op is a first-class citizen), dispatched through
    // the engine, then emitted as log/entry on the event source. One seam op backs the whole op_*
    // family (read/edit/copy/find/fold/look/move/open/send/exec); the module parses at its edge with the
    // grammar package and hands over the statement, then fans the emitted entry out to its own clients.
    async dispatchAsClient(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const { workspaceId, workerId, statement } = args;
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        try {
            const result = await this.#dispatchClientStatement({ workspaceId, workerId, loopId: clientLoopId, statement });
            await Envelope.closeClientLoop(this.#db, clientLoopId, { status: 200 });
            return result;
        } catch (error) {
            await Envelope.closeClientLoop(this.#db, clientLoopId, clientActionFailure(error));
            throw error;
        }
    }

    // The client-interface action contract: one AG-UI action owns one journal segment,
    // regardless of how many statements op.parse produced. A proposed statement may
    // keep this promise (and segment) open across interrupt/resume; settlement closes
    // it. The journal is durable evidence for the action, not a second client lifecycle.
    async dispatchClientAction(args: { workspaceId: number; workerId: number; statements: PlurnkStatement[] }): Promise<Array<{ status: number; [key: string]: unknown }>> {
        const { workspaceId, workerId, statements } = args;
        if (statements.length === 0) return [];
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        try {
            const results = [];
            for (const statement of statements) {
                results.push(await this.#dispatchClientStatement({ workspaceId, workerId, loopId: clientLoopId, statement }));
            }
            await Envelope.closeClientLoop(this.#db, clientLoopId, { status: 200 });
            return results;
        } catch (error) {
            await Envelope.closeClientLoop(this.#db, clientLoopId, clientActionFailure(error));
            throw error;
        }
    }

    async #dispatchClientStatement(args: { workspaceId: number; workerId: number; loopId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const { workspaceId, workerId, loopId, statement } = args;
        const release = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
        try {
            const turnId = await ClientTurn.insertClientTurn(this.#db, loopId);
            const entryIds: number[] = [];
            const result = await this.#engine.dispatch({
                statement, workspaceId, workerId, loopId, turnId, sequence: 1,
                origin: "client", onDispatch: (logEntryId: number) => { entryIds.push(logEntryId); },
            });
            await this.#branchBatches.sealTurn(turnId);
            for (const logEntryId of entryIds) {
                const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                this.#broadcast({ workspaceId }, "log/entry", { entry });
            }
            return result as { status: number; [key: string]: unknown };
        } finally {
            release();
        }
    }

    // op.look (#283/#358) — the pure READ-projection query on the seam: resolve a READ through the
    // full scheme resolver and return its content, writing NO log row — the client's off-run
    // inspection primitive (the module rewrites LOOK→READ and parses at its edge, exactly like
    // dispatchClientAction). Its closed observation segment supplies the numeric loop coordinate
    // required by plugin context and relative log:/// addresses without impersonating an active
    // client lifecycle. It creates no turn or log row. Engine.look enforces READ-only.
    async look(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const { workspaceId, workerId, statement } = args;
        const release = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        try {
            const result = await this.#engine.look({ statement, workspaceId, workerId, loopId: clientLoopId }) as { status: number; [key: string]: unknown };
            await Envelope.closeClientLoop(this.#db, clientLoopId, { status: 200 });
            return result;
        } catch (error) {
            await Envelope.closeClientLoop(this.#db, clientLoopId, clientActionFailure(error));
            throw error;
        } finally {
            release();
        }
    }

    // The log-read hook (#355) — a workspace's journal, the module's primary render input. The worker is
    // ownership-verified against the workspace (a workspace reads only its own runs — the model worker included,
    // #214); entries filter by loop/turn/since-id or the full L/T/S display coordinate. Core owns the
    // journal + the invariant; the module shapes the entries into AG-UI messages at its edge.
    async readLog(args: {
        workspaceId: number; workerId: number;
        loopId?: number; turnId?: number; sinceId?: number; limit?: number;
        loopSeq?: number; turnSeq?: number; sequence?: number;
    }): Promise<LogEntryWire[]> {
        const { workspaceId, workerId } = args;
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (target === undefined) throw new Error(`run ${workerId} not found`);
        if (target.workspace_id !== workspaceId) throw new Error(`run ${workerId} is not in this workspace (${workspaceId})`);
        const rows = await this.#db.log_read_recent_ids.all<{ id: number }>({
            worker_id: workerId,
            loop_id: args.loopId ?? null, turn_id: args.turnId ?? null, since_id: args.sinceId ?? null,
            loop_seq: args.loopSeq ?? null, turn_seq: args.turnSeq ?? null, sequence: args.sequence ?? null,
            limit: Math.min(args.limit ?? 100, 1000),
        });
        const entries: LogEntryWire[] = [];
        for (const r of rows) entries.push(await LogEntry.fetchLogEntry(this.#db, r.id));
        return entries;
    }

    // The metadata-read hooks (#355) — the module's render surface beyond the journal. Thin delegations
    // into core's envelope / membership / provider machinery; the module fans the results into its own views.
    listProviders(): { aliases: Array<{ alias: string; provider: string; model: string; active: boolean; promptBudget: number | null }> } {
        const active = resolveActiveAlias();
        return {
            aliases: parseAliasesFromEnv().map((a) => {
                const isActive = active !== null && active.alias === a.alias;
                return {
                    alias: a.alias, provider: a.provider, model: a.model, active: isActive,
                    // The same effective model-facing budget loop usage reports, including
                    // optional virtual pressure; known for the active alias, null elsewhere.
                    promptBudget: isActive && this.#provider !== null ? this.#engine.promptBudgetFor(this.#provider) : null,
                };
            }),
        };
    }

    listWorkspaces() { return Envelope.listWorkspaces(this.#db); }
    listWorkers(workspaceId: number) { return Envelope.listWorkersForWorkspace(this.#db, workspaceId); }
    listPrompts(workspaceId: number, limit: number = 100) { return Envelope.listPromptsForWorkspace(this.#db, workspaceId, limit); }
    async listMembers(workspaceId: number) {
        const release = await this.#workspaceGate.acquireTurn(workspaceId, 0);
        try {
            return await GitMembership.resolveMembershipEffects(this.#db, workspaceId, undefined);
        } finally {
            release();
        }
    }
    listConstraints(workspaceId: number) {
        return this.#db.crud_list_workspace_constraints.all<{ effect: string; glob: string }>({ workspace_id: workspaceId });
    }
    workspaceDerivationStatus(workspaceId: number) {
        return this.#engine.workspaceDerivationStatus(workspaceId);
    }

    // Workspace lifecycle (#355): the module's workspace-management surface. Inputs arrive already validated
    // at the module's edge ("I am the wall" — settings as the stored JSON string, constraints as a typed
    // array, roots absolute); core owns the envelope, its reserved-name + name-uniqueness invariants,
    // membership resolution, warmWorkspaceDerivations, and the workspace/created emit. No connection state
    // (which client is on which workspace) lives here — that's the module's.
    async createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object; constraints?: Array<{ effect: string; glob: string }> }): Promise<ClientEnvelope> {
        // The SEAM fail-hards on malformed client input (#364 — validation flushed out of the
        // retired WS handlers so every module inherits it): settings bag (#231/#232/#249/#328),
        // constraints (#200), absolute projectRoot.
        const projectRoot = ClientInput.assertProjectRoot("workspace.create", args.projectRoot);
        const settings = ClientInput.parseSettings(args.settings);
        const constraints = ClientInput.parseConstraints(args.constraints);
        const envelope = await Envelope.createClientEnvelope(this.#db, { name: args.name, projectRoot, settings });
        for (const { effect, glob } of constraints) {
            await this.#db.crud_insert_workspace_constraint.run({ workspace_id: envelope.workspaceId, effect, glob });
        }
        if (constraints.length > 0) await GitMembership.resolveGitMembership(this.#db, envelope.workspaceId, undefined);
        await LoopDocs.materialize(this.#engine, this.#db, envelope.workspaceId);
        void this.#engine.warmWorkspaceDerivations(envelope.workspaceId).catch(() => {});
        this.#broadcast("all", "workspace/created", { id: envelope.workspaceId, name: envelope.workspaceName, projectRoot: envelope.projectRoot });
        return envelope;
    }

    async attachWorkspace(args: { workspaceId: number; workerId?: number; workerName?: string }): Promise<ClientEnvelope> {
        // attachToWorkspace owns the reserved-name + run-ownership invariants; the seam just delegates + warms.
        const envelope = await Envelope.attachToWorkspace(this.#db, args.workspaceId, { workerId: args.workerId, workerName: args.workerName });
        void this.#engine.warmWorkspaceDerivations(envelope.workspaceId).catch(() => {});
        return envelope;
    }

    async renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }> {
        if (typeof name !== "string" || name.length === 0) throw new Error("workspace.rename: name must be a non-empty string"); // seam fail-hard (#364)
        const taken = await this.#db.envelope_get_workspace_by_name.get<{ id: number }>({ name });
        if (taken !== undefined && taken.id !== workspaceId) throw new Error(`a workspace named "${name}" already exists — pick another`);
        return { id: workspaceId, name: await Envelope.updateWorkspaceName(this.#db, workspaceId, name) };
    }

    async constrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        const release = await this.#workspaceGate.acquireTurn(workspaceId, 0);
        try {
            ClientInput.assertConstraint("workspace.constrain", effect, glob);
            await this.#db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect, glob });
            await GitMembership.resolveGitMembership(this.#db, workspaceId, undefined);
            // Members may have just landed — begin warming now, but return the constraint response
            // immediately so prompts do not wait for the complete derivation corpus.
            void this.#engine.warmWorkspaceDerivations(workspaceId).catch(() => {});
            return { effect, glob };
        } finally {
            release();
        }
    }

    async unconstrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        const release = await this.#workspaceGate.acquireTurn(workspaceId, 0);
        try {
            ClientInput.assertConstraint("workspace.unconstrain", effect, glob);
            await this.#db.crud_delete_workspace_constraint.run({ workspace_id: workspaceId, effect, glob });
            await GitMembership.resolveGitMembership(this.#db, workspaceId, undefined);
            void this.#engine.warmWorkspaceDerivations(workspaceId).catch(() => {});
            return { effect, glob };
        } finally {
            release();
        }
    }

    // The entry-shape hook (#355) — one entry's channels + tags + metadata at a path. With channel+offset,
    // returns just that channel's content sliced from the offset: the incremental streaming read (#192,
    // the delta leaves storage, not the whole channel). The module renders growing output by re-polling.
    async readEntry(args: { workspaceId: number; target: string; channel?: string; offset?: number }): Promise<{ status: number; entry: EntryShape | null }> {
        const release = await this.#workspaceGate.acquireTurn(args.workspaceId, 0);
        try {
            const m = args.target.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
            if (m === null) throw new Error(`readEntry: target must be URL-shaped (scheme://pathname); got: ${args.target}`);
            if (args.offset !== undefined && args.channel === undefined) throw new Error("readEntry: offset requires channel (which channel to slice)");
            const scheme = m[1];
            const pathname = m[2].split("#")[0];
            const row = await this.#db.entry_read_lookup.get<{ id: number; scope: string; workspace_id: number; scheme: string; pathname: string }>({ workspace_id: args.workspaceId, scheme, pathname });
            if (row === undefined) return { status: 404, entry: null };
            let channelRows: ChannelRow[];
            if (args.channel === undefined) {
                channelRows = await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id });
            } else {
                const r = await this.#db.entry_read_channel_slice.get<ChannelRow>({ entry_id: row.id, channel: args.channel, offset: args.offset ?? 0 });
                channelRows = r === undefined ? [] : [r];
            }
            const channels: EntryShape["channels"] = {};
            for (const c of channelRows) channels[c.name] = { content: c.content, contentLength: c.contentLength, mimetype: c.mimetype, tokens: c.tokens, state: c.state };
            const tagRows = await this.#db.crud_read_tags.all<{ tag: string }>({ entry_id: row.id });
            return { status: 200, entry: { id: row.id, scope: row.scope, workspaceId: row.workspace_id, scheme: row.scheme, pathname: row.pathname, channels, tags: tagRows.map((t) => t.tag) } };
        } finally {
            release();
        }
    }

    // The fork hook (#355) — branch a worker's log into a new worker in the same workspace (#228), sharing the
    // workspace's world (entries + overlay), copying nothing of it. The module resolves the default (the
    // workspace's model worker) from its own connection state and passes the concrete workerId; the seam owns the
    // #366 — a fresh conversation worker: AG-UI threads map to RUNS (§machine-processes — the workspace
    // is the workspace, the worker is the conversation). ensureModelWorker is the stable DEFAULT door,
    // forkWorker the branching door (copies history); this is the fresh door — a named, empty-log,
    // model-origin root that runLoop accepts. New chat = new conversation, same workspace.
    async createConversationWorker(args: { workspaceId: number; name?: string }): Promise<{ workerId: number; workerName: string }> {
        const { workspaceId, name } = args;
        if (name !== undefined && (typeof name !== "string" || name.length === 0)) throw new Error("run.create: name must be a non-empty string");
        const workspace = await this.#db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
        if (workspace === undefined) throw new Error(`run.create: workspace ${workspaceId} not found`);
        if (name !== undefined) {
            if (Envelope.RESERVED_RUN_NAMES.has(name.toLowerCase())) throw new Error(`run.create: name "${name}" is reserved for a non-client actor`);
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) throw new Error(`run.create: a worker named "${name}" already exists — worker names are immutable, pick another`);
        }
        const run = await Envelope.createModelWorker(this.#db, workspaceId, name);
        return { workerId: run.id, workerName: run.name };
    }

    // ownership check and the run-name namespace + uniqueness invariants (names are immutable — no rename).
    async forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }> {
        if (args.name !== undefined && (typeof args.name !== "string" || args.name.length === 0)) throw new Error("run.fork: name must be a non-empty string"); // seam fail-hard (#364)
        const { workspaceId, workerId, name } = args;
        const owner = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (owner === undefined) throw new Error(`forkWorker: run ${workerId} not found`);
        if (owner.workspace_id !== workspaceId) throw new Error(`forkWorker: run ${workerId} is not in workspace ${workspaceId}`);
        if (name !== undefined) {
            if (Envelope.RESERVED_RUN_NAMES.has(name.toLowerCase())) throw new Error(`forkWorker: name "${name}" is reserved for a non-client actor`);
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) throw new Error(`forkWorker: a worker named "${name}" already exists — worker names are immutable, pick another`);
        }
        const branchWorkerId = await Fork.fork(this.#db, workerId, name);
        const branch = await this.#db.envelope_get_worker_by_id.get<{ name: string }>({ id: branchWorkerId });
        return { workerId: branchWorkerId, workerName: branch?.name ?? null, parentWorkerId: workerId };
    }

    // The module-load hook (#355 / #289) — register a runtime into the live registry, driver-agnostic:
    // the kernel knows nothing about MCP or any specific driver. The struct is the booth window agreed
    // with the execs agent (execs-mcp installServer's hotload callback): framework types only — the decl
    // (tag + glyph/example/documentation), the executor, the driver's probe result. RegistryEntry never
    // leaves the kernel; it's wrapped here, mirroring boot. The engine's scheme-face arbitration
    // (reserved / cross-family collision, #240) gates the tag before registering.
    hotloadRuntime(reg: { decl: RuntimeDecl; executor: Executor; availability: RuntimeAvailability }): void {
        const { decl, executor, availability } = reg;
        this.#engine.hotloadRuntime(decl.name, {
            executor,
            glyph: decl.glyph ?? "",
            example: decl.example ?? "",
            documentation: decl.documentation ?? "",
            available: availability.available,
            detail: availability.detail,
        } satisfies RegistryEntry);
    }
    get engine(): Engine { return this.#engine; }
    get provider(): Provider | null { return this.#provider; }
    get schemes(): SchemeRegistry { return this.#schemes; }
    get mimetypes(): Mimetypes { return this.#mimetypes; }

    // The boot plug-point (#355 hook D) — register a plugin module before start(); its init runs at
    // boot with the curated CoreSeam handle, where it opens its own transport/listener. Direct wiring, no
    // plugin-kind abstraction: a second transport earns one if it ever appears. "Here's your handle."
    // The init's return value is ignored — a module may hand back its instance (or nothing).
    #moduleInits: Array<(seam: CoreSeam) => unknown> = [];
    registerModule(init: (seam: CoreSeam) => unknown): void {
        this.#moduleInits.push(init);
    }

    async start(): Promise<void> {
        if (this.#started) throw new Error("daemon already started");
        this.#started = true;

        // Mimetypes owns its own discovery scan over @plurnk/plurnk-mimetypes-*
        // packages; pre-warm it so first index render doesn't pay the cost.
        await this.#mimetypes.ready();

        // Discover + probe the installed executor siblings, then hand the
        // registry to the engine for exec dispatch (plurnk-service#181). The
        // shell is the default runtime, so its executor must boot usable.
        const executors = await ExecutorRegistry.build({ defaultRuntime: "sh", cwd: this.#discoveryCwd });
        this.#engine.setExecutors(executors);
        // §exec — mint a scheme per runtime tag so exec output entries address by tag
        // authority (sh:///l/t/s). The "exec" scheme stays for the EXEC op dispatch.
        this.#schemes.registerRuntimeSchemes(executors);
        // Discover external @plurnk/plurnk-schemes-* siblings + register them
        // (agnostic, by plurnk.kind:"scheme"). They light up http://, etc. with
        // no further engine change — #run wraps their ctx in SchemeCtxImpl (#195).
        await this.#schemes.discoverExternal(this.#discoveryCwd);
        await this.#schemes.ready();

        // Reconcile the kernel-published documentation surface once per existing workspace.
        // Installed capabilities and operator configuration are now fully known; model loops
        // consume this workspace state but never republish it.
        for (const workspace of await Envelope.listWorkspaces(this.#db)) {
            await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
        }

        await this.#recoverLifecycle();

        // #364 — the daemon opens NO transport, ever: plugin modules open theirs via the seam.
        for (const init of this.#moduleInits) await init(this);
    }

    async #recoverLifecycle(): Promise<void> {
        await this.#db.recovery_fail_active_loops.run({});
        await this.#db.recovery_error_orphan_subscription_channels.run({});
        await this.#db.recovery_fail_orphan_subscriptions.run({});
        await this.#db.recovery_resume_unblocked_parks.run({});
        await this.#branchBatches.recover();

        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
        const queued = await this.#db.recovery_queued_workers.all<{
            worker_id: number;
            workspace_id: number;
        }>({});
        for (const row of queued) {
            const started = await this.#ensureDrain({
                workspaceId: row.workspace_id,
                workerId: row.worker_id,
                systemPrompt,
            });
            started?.drainPromise.catch((err: unknown) => {
                console.error(`recovered drain failed for worker ${row.worker_id}:`, err);
            });
        }

        const parked = await this.#db.recovery_parked_workers.all<{
            worker_id: number;
            workspace_id: number;
        }>({});
        for (const row of parked) {
            await this.#schedulePollWake(
                row.workspace_id,
                row.worker_id,
                systemPrompt,
            );
        }
    }

    async stop(): Promise<void> {
        if (!this.#started) return;
        this.#started = false;


        // Drain order: (1) abort in-flight loops via #activeDrains so
        // strike paths don't keep going, (2) await each drain's promise
        // to completion, (3) drain streaming schemes' background work
        // (exec spawn cleanup, channel writes). Only THEN close the DB
        // upstream — drain queries hit the DB right up until they exit.
        // Abort every worker's cancellation scope — stops in-flight loops AND the
        // streams (background execs) linked to them, so idle() doesn't block on
        // a long-running command. Covers runs whose drain already exited but
        // whose exec is still in flight.
        // Settle the stopped world FIRST: a drain paused at a pending proposal awaits a resolution
        // that will never arrive once clients are gone — allSettled(drains) below would deadlock
        // the stop forever (a daemon with a pending HITL proposal could not shut down).
        this.#engine.cancelAllProposals("daemon_stopping");
        this.#branchBatches.beginStop();
        for (const scope of this.#workerAborts.values()) { if (!scope.signal.aborted) scope.abort("daemon_stopping"); }
        for (const t of this.#pollTimers.values()) clearTimeout(t); // drop pending hibernation poll-wakes
        this.#pollBackoff.clear();
        this.#pollTimers.clear();
        // …and the park-DEADLINE timers (#432): a bounded park's timer fires #wakeParkedWorker after
        // stop/db-close if left pending — an unhandled rejection (SqlRite closed) that abnormally
        // exits the worker under load. Symmetric with the poll-wakes above; both must be reaped.
        for (const t of this.#parkTimers.values()) clearTimeout(t);
        this.#parkTimers.clear();
        await this.#branchBatches.idle();
        const drainPromises = [...this.#activeDrains.values()].map((d) => d.promise);
        await Promise.allSettled(drainPromises);
        await this.#drainStreamingSchemes();
        await this.#engine.drainDerivations(); // active workspace warms finish before the db closes upstream
        await this.#schemes.close();
    }

    // Per-scheme idle awaits for clean shutdown. New streaming schemes
    // (SSE, WS) add themselves here as they land.
    async #drainStreamingSchemes(): Promise<void> {
        const exec = this.#schemes.get("exec") as { idle?: () => Promise<void> } | undefined;
        if (exec?.idle !== undefined) await exec.idle();
    }



    /**
     * Emit a stream/event notification scoped to the workspace containing the
     * entry. ChannelWrite helpers (src/core/ChannelWrite.ts) invoke this when
     * they update channel content or state. SPEC §notifications.
     */
    notifyStreamEvent(workspaceId: number, event: { entryId: number; channel: string; state: string; contentLength: number }): void {
        this.#broadcast({ workspaceId }, "stream/event", event);
    }

    /**
     * Emit a transient notice scoped to the workspace containing the loop.
     */
    notifyNotice(workspaceId: number, payload: { loopId: number; notice: Notice }): void {
        this.#broadcast({ workspaceId }, "notice/event", payload);
    }

    /**
     * Inject a prompt into a worker. Two paths:
     *   - Active drain: writes a plurnk://prompt/<run>/<loop>/<next-turn> entry
     *     via Engine.inject. Current loop sees the new prompt at its next
     *     turn. Returns immediately with {action: "injected_next_turn"}.
     *   - No active drain: enqueues a fresh loop with the prompt at
     *     status=100, starts a drain. Returns the drain promise so the
     *     caller can await full completion.
     *
     * Rummy parallel: AgentLoop.inject(). Unified surface — both `loop.run`
     * and wake-on-completion go through this method. §actor-boundary-passive-wake
     */
    // #368 — flags are LOOP-scoped (persisted per loop row; the packet's teaching follows them), so a
    // prompt folding into a live/parked loop cannot re-flag it mid-flight — and it must never PRETEND
    // to: an inject carrying flags that DIFFER from the target loop's effective flags is refused
    // legibly (cancel the loop or omit the flags), never a silent posture discard. Identical or
    // absent flags fold clean.
    async #assertFoldPosture(workerId: number, flags: Partial<LoopFlags> | undefined, loopId?: number): Promise<void> {
        if (flags === undefined || Object.keys(flags).length === 0) return;
        const row = loopId !== undefined
            ? await this.#db.engine_get_loop_flags.get<{ flags: string }>({ loop_id: loopId })
            : await this.#db.drain_active_loop_flags.get<{ id: number; flags: string }>({ worker_id: workerId });
        const effective: Record<string, unknown> = { ...DEFAULT_LOOP_FLAGS, ...JSON.parse(row?.flags ?? "{}") as object };
        const conflicts = Object.entries(flags).filter(([k, v]) => v !== undefined && effective[k] !== v).map(([k, v]) => `${k}: ${JSON.stringify(effective[k])} → ${JSON.stringify(v)}`);
        if (conflicts.length > 0) {
            throw new Error(`inject: the prompt would fold into a live loop whose flags differ (${conflicts.join(", ")}) — flags are loop-scoped and never change mid-flight. Cancel the loop (loop.cancel) and re-run with the new flags, or send the prompt without flags to adopt the loop's posture.`);
        }
    }

    async inject(args: {
        workspaceId: number; workerId: number; prompt: string;
        providerSpec: ProviderAlias; systemPrompt: string;
        maxTurns?: number; flags?: Partial<LoopFlags>; openPaths?: string[];
    }): Promise<{
        action: "injected_next_turn" | "enqueued_new_loop";
        loopId: number;
        turnSeq?: number;
        firstLoopPromise?: Promise<DrainLoopResult>;
        drainPromise?: Promise<unknown>;
    }> {
        const { workspaceId, workerId, prompt } = args;
        // Active loop (status=102)? Fold the wake/prompt into its next turn.
        // engine.inject returns null when no loop is currently executing, so
        // we enqueue a fresh loop below and ensure a drain claims it.
        if (this.#activeDrains.has(workerId)) {
            await this.#assertFoldPosture(workerId, args.flags); // #368 — a fold never silently discards intent
            const active = await this.#db.drain_current_loop_for_worker.get<{ id: number }>({ worker_id: workerId });
            if (active !== undefined) {
                await this.#assertLoopProvider(active.id, args.providerSpec);
                await this.#assertLoopMaxTurns(active.id, args.maxTurns);
            }
            const result = await this.#engine.inject(workerId, prompt);
            if (result !== null) {
                return { action: "injected_next_turn", loopId: result.loopId, turnSeq: result.turnSeq };
            }
        }

        // #55 — a worker PARKED at 202 RESUMES that slept loop in place: the voice door (irc / loop.inject)
        // is a wake edge like a stream/child conclusion, not a fresh loop that orphans the parked one
        // (which would leave the worker non-quiescent forever). engine.inject writes the message as the
        // slept loop's next-turn prompt (the directed message — distinct from the env door, which
        // resumes promptless); then re-queue + drain it. §worker-lifecycle-wake-liveness.
        if (!this.#activeDrains.has(workerId)) {
            const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
            if (slept !== undefined) {
                await this.#assertFoldPosture(workerId, args.flags, slept.id); // #368 — the resume path drops nothing silently either
                await this.#assertLoopProvider(slept.id, args.providerSpec);
                await this.#assertLoopMaxTurns(slept.id, args.maxTurns);
                const injected = await this.#engine.inject(workerId, prompt);
                await this.#lifecycle.wake(slept.id);
                const started = await this.#ensureDrain({
                    workspaceId, workerId, systemPrompt: args.systemPrompt,
                });
                return { action: "injected_next_turn", loopId: slept.id, ...(injected?.turnSeq !== undefined ? { turnSeq: injected.turnSeq } : {}), ...(started ?? {}) };
            }
        }

        const loopId = await this.#enqueueFreshLoop({
            workerId,
            prompt,
            providerSpec: args.providerSpec,
            maxTurns: args.maxTurns,
            flags: args.flags,
            openPaths: args.openPaths,
        });

        // Guarantee a drain claims the loop we just enqueued. #ensureDrain runs its
        // check-and-start UNDER the per-worker drain lock (§worker-lifecycle-single-drain),
        // serialized against a draining sibling's teardown relinquish so the two can't
        // both register a drain (R4). A live drain re-claims the loop in its own
        // iteration or its lock-held exit re-claim, so it's never stranded.
        // firstLoopPromise is present only when THIS call started the drain — loop.run
        // keys its fast-path response on that.
        const started = await this.#ensureDrain({
            workspaceId, workerId, systemPrompt: args.systemPrompt,
        });
        return { action: "enqueued_new_loop", loopId, ...(started ?? {}) };
    }

    async #enqueueFreshLoop(args: {
        workerId: number;
        prompt: string;
        providerSpec: ProviderAlias;
        maxTurns?: number;
        flags?: Partial<LoopFlags>;
        openPaths?: string[];
    }): Promise<number> {
        const seqRow = await this.#db.loop_run_next_sequence.get<{ next: number }>({
            worker_id: args.workerId,
        });
        if (seqRow === undefined) throw new Error("enqueueFreshLoop: next-sequence query returned no row");
        const loopRow = await this.#db.drain_enqueue_loop.get<{ id: number }>({
            worker_id: args.workerId,
            sequence: seqRow.next,
            prompt: args.prompt,
            provider_spec: JSON.stringify(args.providerSpec),
            max_turns: args.maxTurns ?? Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
        });
        if (loopRow === undefined) throw new Error("enqueueFreshLoop: loop enqueue returned no row");
        if (args.flags !== undefined) {
            await this.#db.engine_set_loop_flags.run({
                loop_id: loopRow.id,
                flags: JSON.stringify({ ...DEFAULT_LOOP_FLAGS, ...args.flags }),
            });
        }
        if (args.openPaths !== undefined && args.openPaths.length > 0) {
            await this.#db.engine_set_loop_open_paths.run({
                loop_id: loopRow.id,
                open_paths: JSON.stringify(args.openPaths),
            });
        }
        return loopRow.id;
    }

    /**
     * Start a drain for the given run. The drain claims queued loops via
     * drain_claim_next_loop (atomic 100→102 flip), executes each via
     * Engine.runLoop, and re-checks. Stream-aware: when the queue is empty
     * but the worker has active subscriptions, the drain parks on a
     * #drainPokes signal — wake-on-completion → inject() wakes it. Drain
     * exits when queue is empty AND no active subscriptions remain.
     *
     * Returns both `firstLoopPromise` (resolves once the first loop the
     * drain processes completes — used by loop.run to give the caller a
     * fast response containing their loop's result) and `drainPromise`
     * (resolves only when the whole drain finishes, queue+subs settled).
     */
    #startDrain(opts: {
        workspaceId: number; workerId: number;
        systemPrompt: string;
    }): {
        firstLoopPromise: Promise<DrainLoopResult>;
        drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    } {
        const { workspaceId, workerId, systemPrompt } = opts;
        // The drain runs under the worker's cancellation scope (shared with the
        // execs its loops spawn), so loop.cancel/shutdown abort it as a unit.
        const controller = this.#workerSignal(workerId);
        const handle: { controller: AbortController; promise: Promise<unknown> } = {
            controller, promise: Promise.resolve(),
        };

        let resolveFirst: (v: DrainLoopResult) => void = () => {};
        let rejectFirst: (e: unknown) => void = () => {};
        const firstLoopPromise = new Promise<DrainLoopResult>((res, rej) => {
            resolveFirst = res; rejectFirst = rej;
        });
        let firstSettled = false;

        const claim = () => this.#db.drain_claim_next_loop.get<{
            id: number; sequence: number; prompt: string; max_turns: number;
        }>({ worker_id: workerId });

        const drainPromise = (async () => {
            let loopsDrained = 0;
            let lastResult: DrainLoopResult | null = null;
            let currentLoopId: number | null = null; // the loop being drained — for the #204 abort→499 resolution below
            try {
                while (true) {
                    controller.signal.throwIfAborted();
                    let loopRow = await claim();
                    if (loopRow === undefined) {
                        // Queue empty → teardown UNDER the per-worker drain lock (R4 / I1),
                        // serialized against #ensureDrain so a concurrent inject can't
                        // start a 2nd drain in the gap. Re-claim while holding the lock;
                        // relinquish the registry slot only if it's empty too. A loop
                        // that raced in is returned and run — we stay registered, so
                        // there's no transient delete for #ensureDrain to catch.
                        loopRow = await this.#withDrainLock(workerId, async () => {
                            const claimed = await claim();
                            if (claimed === undefined && this.#activeDrains.get(workerId) === handle) {
                                this.#activeDrains.delete(workerId);
                            }
                            return claimed;
                        });
                        if (loopRow === undefined) break;
                    }
                    currentLoopId = loopRow.id;
                    // #598 — provider identity belongs to the claimed loop, not the
                    // drain that happened to claim it. A drain can consume multiple
                    // queued loops; resolve each durable selection at this boundary.
                    const provider = await this.#providerForLoop(loopRow.id);
                    const onDispatch = (logEntryId: number): void => {
                        // #506 — a rejection here was a silent process-death vector (unhandled in a
                        // fire-and-forget void); a log-broadcast failure must never crash the drain.
                        void (async () => {
                            const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                            this.#broadcast({ workspaceId }, "log/entry", { entry });
                        })().catch((e: unknown) => console.error("log/entry broadcast failed:", e instanceof Error ? e.message : String(e)));
                    };
                    const result = await this.#engine.runLoop({
                        provider, workspaceId, workerId, loopId: loopRow.id, maxTurns: loopRow.max_turns,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: loopRow.prompt },
                        ],
                        origin: "model",
                        onDispatch,
                        signal: controller.signal,
                    });
                    if (result.result.status === 202) {
                        // The loop slept via SEND[202] — suspended, not terminated. Leave it at 202
                        // (resumable); no loop/terminated, no orphan-reconcile. A stream conclusion
                        // (#handleWakeWorker) re-queues it; and if it holds a polled stream, a poll timer
                        // wakes it every P to inspect (§exec-poll). §worker-lifecycle-wake-liveness.
                        void this.#schedulePollWake(workspaceId, workerId, systemPrompt).catch((err: unknown) => console.error("poll-wake scheduling failed:", err instanceof Error ? err.message : String(err)));
                        // §send-premature-terminate/SEND[202]<T> — the park deadline:
                        // dispatcher recorded the marker's seconds; a bounded park is woken at T
                        // regardless of arrivals, so a park always has a next turn. -1 (indefinite:
                        // the butler, a [300] ask) schedules nothing — irc/inject/conclusions wake it.
                        // In-memory: a daemon restart drops pending deadlines.
                        if (currentLoopId !== null) {
                            const deadline = this.#engine.parkDeadlines.get(currentLoopId);
                            this.#engine.parkDeadlines.delete(currentLoopId);
                            const prior = this.#parkTimers.get(workerId);
                            if (prior !== undefined) { clearTimeout(prior); this.#parkTimers.delete(workerId); }
                            if (deadline !== undefined && deadline > 0) {
                                const t = setTimeout(() => {
                                    this.#parkTimers.delete(workerId);
                                    void this.#wakeParkedWorker(workspaceId, workerId, systemPrompt).catch((err: unknown) => console.error("park-deadline wake failed:", err instanceof Error ? err.message : String(err)));
                                }, deadline * 1000);
                                t.unref();
                                this.#parkTimers.set(workerId, t);
                            }
                        }
                        // Honor an OWED wake (§worker-lifecycle-child-wake): a child/stream concluded while
                        // this worker was mid-turn, before it slept — resume in place rather than park blind,
                        // so a worker-run hibernation always returns. The loop is 202 here; reset to
                        // claimable and the drain re-runs it on the next claim below.
                        if (this.#owedWakes.delete(workerId)) {
                            await this.#lifecycle.wake(loopRow.id);
                            currentLoopId = null;
                            continue;
                        }
                        // The loop is blocked at 202 on a live obligation (§wait-obligation-matrix);
                        // that obligation's conclusion is its wake edge (the owed-wake above covers the
                        // conclude-before-block race). An idle wait never reaches here — it concluded at dispatch.
                        currentLoopId = null;
                        continue;
                    }
                    this.#owedWakes.delete(workerId); // the loop concluded (non-202) — no park to honor a held wake at
                    const usage = await this.#engine.loopUsage(loopRow.id);
                    const turnIds = await this.#lifecycle.turnIds(loopRow.id);
                    this.#broadcast({ workspaceId }, "loop/terminated", {
                        workerId,
                        loopId: loopRow.id,
                        result: result.result,
                        hitMaxTurns: result.hitMaxTurns,
                        turnIds,
                        usage,
                    });
                    loopsDrained++;
                    const loopResult: DrainLoopResult = {
                        loopId: loopRow.id,
                        turnIds,
                        result: result.result,
                        hitMaxTurns: result.hitMaxTurns,
                        usage,
                    };
                    lastResult = loopResult;
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst(loopResult);
                    }
                    // A next-turn prompt this loop ended before consuming (a
                    // wake conclusion or a loop.run-while-active) is promoted to
                    // a fresh queued loop so it's never silently dropped.
                    await this.#reconcileOrphanedWake(workerId, loopRow.id);
                    currentLoopId = null;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // #204 / Model 3 — loop.cancel / shutdown aborted the live drain. A cancellation
                    // is the loop's TERMINAL state (499), delivered via loop/terminated (loop.run no
                    // longer blocks to return it). A genuine error rejects firstLoopPromise.
                    const usage = currentLoopId === null
                        ? { promptTokens: 0, completionTokens: 0, costUsd: 0, contextTokens: 0, promptBudget: null, meta: {} }
                        : await this.#engine.loopUsage(currentLoopId);
                    if (currentLoopId !== null) {
                        // #380 (owner ruling) — the cancel is allowed but provenanced: the ROW goes
                        // terminal 499 (a dead loop must never read as live 102, #311) carrying
                        // terminated_by='cancel' + the abort reason as the abandonment message, and
                        // the broadcast carries the same message. The abort reason is the client's
                        // loop.cancel reason (cancelDrain threads it through scope.abort).
                        const message = String(controller.signal.reason ?? "user_cancelled").slice(0, 500);
                        const cancelled = await this.#lifecycle.finish(
                            currentLoopId,
                            Results.failure("lifecycle:cancel", "loop-cancelled", 499, message),
                            { terminatedBy: "cancel" },
                        );
                        if (cancelled !== null) {
                            this.#broadcast({ workspaceId }, "loop/terminated", {
                                workerId,
                                loopId: currentLoopId,
                                result: cancelled,
                                hitMaxTurns: false,
                                turnIds: await this.#lifecycle.turnIds(currentLoopId),
                                usage,
                            });
                        }
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst({
                            loopId: currentLoopId ?? 0,
                            turnIds: [],
                            result: currentLoopId === null
                                ? Results.failure("lifecycle:cancel", "loop-cancelled", 499, String(controller.signal.reason ?? "user_cancelled"))
                                : await this.#lifecycle.result(currentLoopId)
                                    ?? Results.failure("lifecycle:cancel", "loop-cancelled", 499, String(controller.signal.reason ?? "user_cancelled")),
                            hitMaxTurns: false,
                            usage,
                        });
                    }
                } else {
                    // #265 — a genuine (non-abort) loop error must still reach the client. loop.run only
                    // acknowledged queueing, so loop/terminated is the sole outcome channel; the rejection
                    // alone reaches no one (firstLoopPromise/drainPromise are .catch()'d). Broadcast 500
                    // (failed) — distinct from an abort's 499 — for every error, not just the pre-first one.
                    // #506 — the WHY must reach every forensic channel, not one. The old handler
                    // fed only the loop row + broadcast; run54 died with the daemon log silent and
                    // a bare 500 — the cause (a stack) reachable nowhere. The daemon-log line still
                    // fires when currentLoopId is null or the row-write itself failed; otherwise the
                    // durable loop result and loop/terminated notification preserve the exact Problem.
                    console.error(`drain error (workspace ${workspaceId}, worker ${workerId}, loop ${currentLoopId ?? "?"}):`, err);
                    if (currentLoopId !== null) {
                        const failure = err instanceof OperationFailureError
                            ? err.result
                            : Results.failure(
                                "daemon:drain",
                                "loop-threw",
                                500,
                                (err instanceof Error ? err.message : String(err)).slice(0, 500),
                            );
                        const settled = await this.#lifecycle.finish(currentLoopId, failure)
                            ?? await this.#lifecycle.result(currentLoopId);
                        if (settled === null) {
                            throw new Error(`drain could not settle loop ${currentLoopId}`, { cause: err });
                        }
                        const usage = await this.#engine.loopUsage(currentLoopId);
                        this.#broadcast({ workspaceId }, "loop/terminated", {
                            workerId,
                            loopId: currentLoopId,
                            result: settled,
                            hitMaxTurns: false,
                            turnIds: await this.#lifecycle.turnIds(currentLoopId),
                            usage,
                        });
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        rejectFirst(err);
                    }
                }
                throw err;
            } finally {
                if (!firstSettled) {
                    firstSettled = true;
                    rejectFirst(new Error("drain exited without producing a result"));
                }
                if (this.#activeDrains.get(workerId) === handle) this.#activeDrains.delete(workerId);
            }
            return { loopsDrained, lastResult };
        })();

        handle.promise = drainPromise;
        this.#activeDrains.set(workerId, handle);
        // Topology join (§run-lifecycle): when this drain exits having CONCLUDED the worker, wake its parent
        // if parked. Runs after the drain fully tears down (settled promise) so the quiescence check sees
        // final state; speculative (#onDrainExit no-ops unless the worker concluded AND the parent is parked).
        void drainPromise.then(
            () => this.#onDrainExit(workspaceId, workerId, systemPrompt),
            () => this.#onDrainExit(workspaceId, workerId, systemPrompt),
        ).catch((err: unknown) => {
            console.error(`parent wake after worker ${workerId} settlement failed:`, err);
        });
        // Swallow unhandled rejections (drain aborts with no awaiter); the
        // error already surfaced via firstLoopPromise or was logged inside.
        drainPromise.catch(() => {});
        firstLoopPromise.catch(() => {});
        return { firstLoopPromise, drainPromise };
    }

    // Per-run drain-transition lock (R4 / §worker-lifecycle-single-drain). #ensureDrain's
    // start and a drain's teardown relinquish both run under it, serialized, so the two
    // can't interleave and register two drains for one worker. The critical section is the
    // registry decision only (never a loop's work) — a sub-ms hop at drain boundaries.
    // A promise-chain mutex: each caller awaits the prior holder; the tail self-prunes
    // when idle so the Map stays bounded to runs mid-transition.
    #withDrainLock<T>(workerId: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.#drainLocks.get(workerId) ?? Promise.resolve();
        const run = prev.then(fn, fn);
        const tail = run.catch(() => {});
        this.#drainLocks.set(workerId, tail);
        void tail.then(() => { if (this.#drainLocks.get(workerId) === tail) this.#drainLocks.delete(workerId); });
        return run;
    }

    // The drain guarantee, serialized per worker via #withDrainLock so it can't race a
    // sibling drain's teardown relinquish into a double-drain (R4). A live drain
    // (registered, NOT aborting) will claim the just-enqueued loop in its own iteration
    // or its lock-held exit re-claim → return null. A registered-but-ABORTING drain is
    // in teardown and won't claim, so we don't defer to it — start fresh, or the loop
    // strands on a cancel/resume race (I6 no-lost-loop). Otherwise start one.
    #ensureDrain(opts: {
        workspaceId: number; workerId: number;
        systemPrompt: string;
    }): Promise<{
        firstLoopPromise: Promise<DrainLoopResult>;
        drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    } | null> {
        return this.#withDrainLock(opts.workerId, async () => {
            const existing = this.#activeDrains.get(opts.workerId);
            if (existing !== undefined && !existing.controller.signal.aborted) return null;
            return this.#startDrain(opts);
        });
    }

    // After a loop terminates, promote any next-turn prompt it never consumed —
    // an injected wake (stream conclusion) or a loop.run-while-active prompt
    // that landed on a turn the loop didn't reach — into a fresh queued loop.
    // The drain claims it on its next iteration, so a conclusion or client
    // prompt is never silently dropped. Inherits the ended loop's flags.
    async #reconcileOrphanedWake(workerId: number, endedLoopId: number): Promise<void> {
        const endedSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: endedLoopId }))?.sequence ?? endedLoopId;
        const prefix = promptLoopPrefix(endedSeq);
        const orphan = await this.#db.drain_orphaned_prompt_for_loop.get<{
            body: string; flags: string | null; provider_spec: string;
        }>({ loop_id: endedLoopId, owner_id: workerId, pattern: `${prefix}%` });
        if (orphan === undefined) return;
        const seqRow = await this.#db.loop_run_next_sequence.get<{ next: number }>({ worker_id: workerId });
        if (seqRow === undefined) throw new Error("reconcileOrphanedWake: next-sequence query returned no row");
        const fresh = await this.#db.drain_enqueue_loop.get<{ id: number }>({
            worker_id: workerId, sequence: seqRow.next, prompt: orphan.body,
            provider_spec: orphan.provider_spec,
            max_turns: (await this.#db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: endedLoopId }))?.max_turns
                ?? Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
        });
        if (fresh === undefined) throw new Error("reconcileOrphanedWake: enqueue returned no row");
        if (orphan.flags !== null) {
            await this.#db.engine_set_loop_flags.run({ loop_id: fresh.id, flags: orphan.flags });
        }
    }

    // The worker's cancellation scope — lazily created, and replaced once aborted
    // so a later loop.run gets a live signal. The drain and the execs its loops
    // spawn all run under it.
    #workerSignal(workerId: number): AbortController {
        const existing = this.#workerAborts.get(workerId);
        if (existing !== undefined && !existing.signal.aborted) return existing;
        const fresh = new AbortController();
        this.#workerAborts.set(workerId, fresh);
        return fresh;
    }

    async #cancelTree(workerId: number, reason: string, includeRoot: boolean): Promise<void> {
        const cancelled = await this.#lifecycle.cancelTree(workerId, reason, includeRoot);
        for (const targetWorkerId of cancelled.workerIds) {
            const pollTimer = this.#pollTimers.get(targetWorkerId);
            if (pollTimer !== undefined) { clearTimeout(pollTimer); this.#pollTimers.delete(targetWorkerId); }
            const parkTimer = this.#parkTimers.get(targetWorkerId);
            if (parkTimer !== undefined) { clearTimeout(parkTimer); this.#parkTimers.delete(targetWorkerId); }
            this.#pollBackoff.delete(targetWorkerId);
            this.#owedWakes.delete(targetWorkerId);
            const scope = this.#workerAborts.get(targetWorkerId);
            if (scope !== undefined && !scope.signal.aborted) scope.abort(reason);
        }
        await Promise.all(cancelled.workerIds.map(async (targetWorkerId) => this.#reapWorkerStreams(targetWorkerId)));
        for (const { loopId, workerId: targetWorkerId, result } of cancelled.loops) {
            const row = await this.#db.drain_get_worker_workspace.get<{ workspace_id: number }>({ worker_id: targetWorkerId });
            if (row === undefined) continue;
            const usage = await this.#engine.loopUsage(loopId);
            this.#broadcast({ workspaceId: row.workspace_id }, "loop/terminated", {
                workerId: targetWorkerId,
                loopId,
                result,
                hitMaxTurns: false,
                turnIds: await this.#lifecycle.turnIds(loopId),
                usage,
            });
        }
    }

    async #cancelWorkerTree(workerId: number, reason: string): Promise<void> {
        await this.#cancelTree(workerId, reason, true);
    }

    /**
     * Cancel the worker's in-flight work (loop.cancel). One abort, one scope: the
     * run signal stops the running loop's turn generation AND tears down every
     * stream linked to it — a background exec that outlived its loop, or even a
     * spawn that registers after this abort (it self-aborts against the aborted
     * signal). Returns cancelled iff there was work. Queued loops stay enqueued.
     */
    cancelDrain(workerId: number, reason: string = "user_cancelled"): boolean {
        const hadDrain = this.#activeDrains.has(workerId);
        const hadWork = hadDrain || this.#workerHasActiveStreams(workerId);
        // A cancel is deliberate — kill any pending hibernation poll-wake so it can't resurrect the worker.
        const pollTimer = this.#pollTimers.get(workerId);
        if (pollTimer !== undefined) { clearTimeout(pollTimer); this.#pollTimers.delete(workerId); }
        // Stop the active drain's turn-generation (its loop closes 499). The worker
        // signal is the optimization path — the fast, listener-driven reap.
        // Durable structured cancellation: one recursive transition claims the
        // worker and every unresolved descendant, then reaps each process-local scope.
        void this.#cancelWorkerTree(workerId, reason).catch((err: unknown) => {
            console.error(`cancelTree(${workerId}) failed:`, err);
        });
        return hadWork;
    }

    // Does the worker have an in-flight stream (a background exec)? Used only for
    // loop.cancel's cancelled=true/false answer; the teardown itself rides the
    // run signal. Duck-typed like #drainStreamingSchemes.
    #workerHasActiveStreams(workerId: number): boolean {
        const exec = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean } | undefined;
        return exec?.hasActiveSpawns?.(workerId) ?? false;
    }

    // The contract-routed reap (§worker-lifecycle-total-reap): durable rows enumerate
    // every open subscription; the live registry invokes its exact callable owner.
    // The worker signal is only the fast path. An exec mid-spawn or a background exec
    // from a past loop is caught regardless of listener timing. Idempotent — a stream
    // the signal already reaped shares the same registry cancellation.
    async #reapWorkerStreams(workerId: number): Promise<void> {
        const open = await ChannelWrite.findOpenSubscriptionsForWorker(this.#db, workerId);
        await Promise.all(open.map(({ id }) => this.#engine.cancelSubscription(id)));
    }

    /**
     * Wake-on-completion handler. Streaming schemes call this when a
     * subscription closes. If the worker has an active loop, the channel
     * transition will surface at that loop's next turn boundary — no new
     * loop needed. Otherwise we open a fresh loop with the synthetic
     * summary as the user prompt so the model gets a chance to react.
     *
     * Skipped on result.status=499 (aborted): the model already knows about
     * its own SEND[499], and a forcefully-cancelled loop's spawn-abort
     * shouldn't resurrect into a wake loop (defeats the cancel).
     *
     * Rummy parallel: plugins/stream/stream.js stream/completed wake:true.
     */
    async #handleWakeWorker(payload: WakeWorkerPayload): Promise<void> {
        // §search-gate — settle the dedup registration: promote on a 200 conclusion, drop on
        // failure (a dead search must never serve as a duplicate). No-op for non-search streams.
        this.#engine.searchGate.settle(payload.target.replace(/^[a-z+.-]+:\/\//, "/").replace(/^\/+/, "/"), payload.result.status);
        // Aborted streams don't wake — the abort was deliberate.
        if (payload.result.status === 499) {
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...payload, wakeAction: "skipped-aborted",
            });
            return;
        }

        // No resurrection (§worker-lifecycle-no-resurrection): a non-499 completion whose
        // run was CANCELLED (idle + its scope aborted) must not start a fresh drain —
        // the cancel was deliberate. The deliverable is already in the channel/log and
        // surfaces as a `collect` environment delta (§env-delta) if the worker is read or
        // resumed; we just don't inject a turn. (An active run folds the wake into its
        // next turn via inject below; a resumed run is active, never aborted, so it is
        // unaffected.)
        const scope = this.#workerAborts.get(payload.workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(payload.workerId)) {
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...payload, wakeAction: "skipped-cancelled",
            });
            return;
        }

        try {
            const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");

            // A slept (202) loop means the worker parked via SEND[202] → resume it in place: re-queue
            // it (202→100) so the drain re-claims and CONTINUES it (seq>1 → no re-foist). Checked
            // FIRST: the slept status is the worker's true disposition regardless of a draining
            // sibling mid-teardown (the #ensureDrain lock serializes the re-claim). No fresh loop,
            // no summary-as-prompt — the resumed loop reads the concluded stream's own state from
            // the manifest. §worker-lifecycle-wake-liveness.
            const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: payload.workerId });
            if (slept !== undefined) {
                await this.#lifecycle.wake(slept.id);
                const started = await this.#ensureDrain({
                    workspaceId: payload.workspaceId, workerId: payload.workerId,
                    systemPrompt,
                });
                this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                    ...payload, wakeAction: "resumed-loop", wakeLoopId: slept.id,
                });
                started?.drainPromise?.catch((err: unknown) => {
                    console.error("wake resume drain failed:", err instanceof Error ? err.message : String(err));
                });
                return;
            }

            // No slept loop. A live loop surfaces the concluded stream ambiently via the
            // environment-observation injector (§exec-stream) on its next turn — there is no prompt
            // to inject and NO task to overwrite. The obsolete "automated environment update"
            // synthesis (which clobbered the model's actual goal) is retired; just tell the client.
            if (this.#activeDrains.has(payload.workerId)) {
                this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                    ...payload, wakeAction: "no-op-active-loop",
                });
                return;
            }

            // No slept loop, no active drain — nothing to resume (e.g. a SEND[200]-done run whose
            // streams were swept). Surface the conclusion without opening a loop.
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...payload, wakeAction: "no-loop",
            });
        } catch (err) {
            console.error("wake-on-completion setup failed:", err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * grammar 0.74.20 EXEC `<T,P>` — schedule a hibernation poll-wake. Called when a loop parks at
     * a park; if the worker holds an open polled stream, arm a timer for its tightest cadence P that
     * resumes the slept loop so the model inspects progress. While the loop is ACTIVE there is no
     * poll work — ambient folded stream deltas already surface progress (§exec-stream); the wake
     * matters only across hibernation. A wake-edge-less 202 (no polled stream) gets no timer. §exec-poll
     */
    async #schedulePollWake(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        const existing = this.#pollTimers.get(workerId);
        if (existing !== undefined) { clearTimeout(existing); this.#pollTimers.delete(workerId); }
        const row = await this.#db.drain_worker_min_poll.get<{ open_count: number; poll_seconds: number | null }>({ worker_id: workerId });
        if ((row?.open_count ?? 0) === 0) {
            this.#pollBackoff.delete(workerId);
            return;
        }
        const pollSec = row?.poll_seconds ?? null;
        // #521 (§exec-poll, owner-ruled) — the poll cadence for a parked exec stream:
        //   explicit <,P> (P>0)  → fixed cadence P, reset the backoff (today's behavior).
        //   explicit <,0>        → poll_seconds=0 stored → blind opt-out (an exec a model wants unwatched).
        //   absent <,P> + a LIVE stream → EXPONENTIAL BACKOFF (base*2^min(step,turns-1)), so a hung
        //     exec is no longer park-blind-forever: the model regains a turn every tick to read
        //     partial output and re-park a slow long-runner or KILL a stuck one (no auto-kill — only
        //     the model tells a silent deadlock from a silent `cargo build`).
        //   no open stream at all → nothing to poll (a child-join park is woken by the child terminal).
        let delayMs: number;
        if (pollSec !== null && pollSec > 0) {
            this.#pollBackoff.delete(workerId);
            delayMs = pollSec * 1000;
        } else if (pollSec === 0) {
            this.#pollBackoff.delete(workerId);
            return; // explicit opt-out
        } else {
            // An open stream without an explicit cadence uses the stream polling floor.
            // Child joins never enter this branch: durable child settlement is their only wake edge.
            const base = Number(process.env.PLURNK_SERVICE_EXEC_POLL_SEC ?? "60");
            const turns = Number(process.env.PLURNK_SERVICE_EXEC_POLL_TURNS ?? "8");
            const step = this.#pollBackoff.get(workerId) ?? 0;
            delayMs = execPollBackoffMs(step, base, turns);
            this.#pollBackoff.set(workerId, step + 1);
        }
        // Floored by the post-EXEC breath (PLURNK_SERVICE_EXEC_WAIT_MS) so a `<…,1>` can't wake the loop
        // faster than a turn settles — §exec-poll.
        const execWaitMs = Number(process.env.PLURNK_SERVICE_EXEC_WAIT_MS ?? "0");
        const timer = setTimeout(() => {
            this.#pollTimers.delete(workerId);
            void this.#wakeParkedWorker(workspaceId, workerId, systemPrompt);
        }, Math.max(delayMs, execWaitMs));
        timer.unref();
        this.#pollTimers.set(workerId, timer);
    }

    /** Resume `workerId`'s slept (202) loop in place — the same 202→100 resume #handleWakeWorker uses, minus a
     *  wake payload. The shared wake primitive: a poll cadence (§exec-poll), a watched stream concluding,
     *  or a child worker finishing (§run-lifecycle topology join) all call this. A no-op if the worker was
     *  cancelled or isn't actually parked (no slept loop) — so calling it speculatively is safe. */
    async #wakeParkedWorker(workspaceId: number, workerId: number, systemPrompt: string, oweIfActive = true): Promise<void> {
        const scope = this.#workerAborts.get(workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(workerId)) return; // cancelled — no resurrection
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            // Not parked. If a drain is still ACTIVE, the worker is mid-turn and about to park — the
            // conclusion that fired this wake arrived before the 202 committed (the conclude-before-park
            // race). OWE the wake: the drain honors it at park so a worker-run hibernation never deadlocks.
            // (No active drain → already concluded/running; nothing to wake.)
            if (oweIfActive && this.#activeDrains.has(workerId)) this.#owedWakes.add(workerId);
            return;
        }
        await this.#lifecycle.wake(slept.id);
        const started = await this.#ensureDrain({
            workspaceId, workerId, systemPrompt,
        });
        started?.drainPromise?.catch((err: unknown) => {
            console.error("wake-parked resume drain failed:", err instanceof Error ? err.message : String(err));
        });
    }

    /** A worker's drain exited. If the worker truly CONCLUDED — no 202-blocked loop, no open stream — then
     *  wake its PARENT in place if the parent is blocked on the join (the structured-concurrency join — a
     *  child finishing is the wake edge for a parent that waited on it, §worker-lifecycle-child-wake). A worker
     *  blocked at 202, or still holding a stream, is NOT concluded — its own wake edges drive it, not this.
     *  The parent reads the child's deliverable from its own log (the §worker-scheme-collect delta) on
     *  resume — control edge here, never an injected prompt. Recurses up via the parent's own drain-exit. */
    async #onDrainExit(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept !== undefined) return; // parked at 202 — not concluded, the worker is still alive
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        if (openSubs.length > 0) return; // a stream still runs — its conclusion re-evaluates, not this exit
        const parent = await this.#db.worker_parent_id.get<{ parent_worker_id: number | null }>({ worker_id: workerId });
        if (parent?.parent_worker_id == null) return; // a root run — nobody to wake
        await this.#wakeParkedWorker(workspaceId, parent.parent_worker_id, systemPrompt);
    }

    // #506 — a SUBSCRIBER throw must never propagate into engine control flow: a transport
    // module's bad socket rethrowing through the emitter was the run54/55 death class (an
    // unhandled rejection in the one then-uncaught dispatch void). The transport's failure is
    // its own — logged loudly per event, never the engine's crash.
    #emitTo(workspaceId: number | null, method: string, params?: unknown): void {
        for (const sub of this.#eventSubscribers) {
            try { sub(workspaceId, method, params); }
            catch (e) { console.error(`seam subscriber failed on ${method}:`, e instanceof Error ? e.message : String(e)); }
        }
    }

    #broadcast(target: NotifyTarget, method: string, params?: unknown): void {
        if (target === "all") {
            // A global engine event (e.g. workspace/created) — emitted to the seam with workspaceId null (#355).
            this.#emitTo(null, method, params);
            return;
        }
        // Publish the raw event to the in-process source first (#355) — transport modules subscribe
        // here (plurnk-agui renders to AG-UI+). Each subscriber owns its own fan-out; core just emits.
        // Scope-stamping onto the notification envelope (§notifications-envelope-carries-workspaceid)
        // is each subscriber's edge concern now — the seam hands (workspaceId, method, params) raw.
        this.#emitTo(target.workspaceId, method, params);
    }
}

// The curated seam handed to a plugin module at boot (#355 hook D) — the client-interface contract,
// not the daemon's guts. A module couples to this (or its own structural mirror) and nothing else; the
// non-seam surface (start/stop/#internals) is not part of the contract. Derived from Daemon so the two
// never drift.
export type CoreSeam = Pick<Daemon,
    | "subscribeToEvents"
    | "pendingProposals" | "resolveProposal"
    | "runLoop" | "cancelDrain" | "dispatchClientAction" | "ensureModelWorker"
    | "readLog" | "readEntry" | "look"
    | "listProviders" | "listWorkspaces" | "listWorkers" | "listPrompts" | "listMembers" | "listConstraints" | "workspaceDerivationStatus"
    | "createWorkspace" | "attachWorkspace" | "createConversationWorker" | "renameWorkspace" | "constrain" | "unconstrain"
    | "forkWorker"
    | "hotloadRuntime"
>;
