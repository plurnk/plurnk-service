// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the transport-free plugin-module seam ({§rpc}).

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Db } from "../core/Db.ts";
import { execPollBackoffMs } from "./exec-poll-backoff.ts";
import type { ProposalResolution } from "../core/ProposalLifecycle.ts";
import ChannelWrite, { type StreamEventPayload, type WakeWorkerPayload } from "../core/ChannelWrite.ts";
import { Paths } from "../index.ts";
import Engine, { type LoopUsage } from "../core/Engine.ts";
import ExecutorRegistry from "../core/ExecutorRegistry.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { RuntimeDeclaration } from "@plurnk/plurnk-execs";
import { aggregateProviderAccounting, type Provider, type ProviderAlias } from "@plurnk/plurnk-providers";
// {§notifications-envelope-carries-workspaceid}: "all" = a global event
// (workspace/created), {workspaceId} = workspace-scoped.
export type NotifyTarget = "all" | { workspaceId: number };
// One drained loop's terminal shape — the drain's return currency.
export interface DrainLoopResult { loopId: number; result: SchemeResult; hitMaxTurns: boolean; turnIds: number[]; action?: string; usage?: LoopUsage; attributions?: string[] }
import {
    parsePath,
    Validator,
    type ClientDisplayCapabilities,
    type ClientEntryChannel,
    type EntryReadResult,
    type Notice,
    type ProposalProjection,
} from "@plurnk/plurnk-contracts";
export type { ProposalProjection as PendingProposal } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import LogEntry from "./logEntry.ts";
import type { LogEntryWire } from "./logEntry.ts";
import Envelope from "./envelope.ts";
import ClientInput from "./client-input.ts";
import type { ClientEnvelope } from "./envelope.ts";
import JournalTurn from "../core/JournalTurn.ts";
import LoopDocs from "./loopDocs.ts";
import GitMembership from "../core/git-membership.ts";
import Fork from "../core/fork.ts";
import WorkerName from "../core/WorkerName.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import { promptLoopPrefix } from "../core/plurnk-uri.ts";
import { rulerCount } from "../core/token-ruler.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopAlias } from "./loop-model.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { LoopFlags } from "../core/types.ts";
import LoopFlagsReader from "../core/LoopFlagsReader.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import WorkspaceGate from "../core/WorkspaceGate.ts";
import BranchBatches from "./BranchBatches.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import type {
    DaemonModule,
    ModuleActionHandler,
    ModuleSetupSeam,
    RuntimeRegistration,
    StartedModule,
} from "./DaemonModule.ts";
import { observed, observedSync } from "../observe/spans.ts";
import { LOOP_TERMINALS, recordCounter } from "../observe/metrics.ts";
import { readOptimisticSettlementMs } from "../core/optimistic-settlement.ts";

interface CompletionWakeGate {
    conclusions: number;
    poke: PromiseWithResolvers<void>;
    promise: Promise<void>;
}

const clientActionFailure = (error: unknown): SchemeResult => {
    if (error instanceof OperationFailureError) return error.result;
    console.error("Client action failed outside its operation result contract:", error);
    return Results.failure(
        "daemon:client",
        "action-threw",
        500,
        "The client action failed outside its operation result contract.",
        {},
        {
            stage: "client-action",
            retryable: false,
        },
    );
};

const daemonFailure = (
    owner: string,
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure(owner, code, status, detail, {}, extensions),
);

type ChannelRow = { name: string } & ClientEntryChannel;
type TurnCeilingSelection = Readonly<{
    effective: number;
    source: "implicit" | "explicit";
}>;

const entryReadResult = (result: unknown): EntryReadResult =>
    Validator.assertEntryReadResult(result as EntryReadResult);

export default class Daemon {
    #db: Db;
    #engine: Engine;
    #workspaceGate: WorkspaceGate;
    #branchBatches: BranchBatches;
    #lifecycle: LoopLifecycle;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    readonly #ownsMimetypes: boolean;
    #provider: Provider | null;
    #nodeModulesPath: string;
    #discoveryCwd: string;
    #started = false; // {§module-lifecycle}: one discovery/module boot; no listener
    #capabilitiesPublished = false;
    #modules: Array<DaemonModule<CoreSeam>> = [];
    #moduleClosers: StartedModule[] = [];
    #moduleActions = new Map<string, ModuleActionHandler>();
    // {§methods-event-subscribe} — the broadcast's in-process event source. A transport
    // module (plurnk-agui) subscribes and fans out to its OWN clients; core emits, never owns
    // client transport or connection state.
    #eventSubscribers = new Set<(workspaceId: number | null, method: string, params: unknown) => void>();

    // Worker-level drain registry. At most one drain per worker. The stored object
    // is the drain's identity handle: start/exit compare it by reference so a
    // drain exiting never clobbers a successor that raced in, and a loop
    // enqueued during teardown is never stranded. A drain is a pure queue
    // consumer (claim → run → exit on empty queue); streams live independently
    // (subscriptions + Exec.idle), and a concluding stream routes through
    // inject() like any other loop source.
    #activeDrains = new Map<number, { controller: AbortController; promise: Promise<unknown> }>();
    #drainExitTasks = new Set<Promise<void>>();
    // Per-worker cancellation scope. Loops AND the streams they spawn (execs)
    // share this signal, so loop.cancel / shutdown abort it once and every
    // in-flight subscription tears down — even a spawn that registers AFTER the
    // cancel self-aborts against the already-aborted signal (no race). Outlives
    // any single (ephemeral) drain; replaced with a fresh controller once
    // aborted so a later runLoop request isn't born cancelled.
    #workerAborts = new Map<number, AbortController>();
    // grammar 0.74.20 EXEC `<T,P>` — per-worker hibernation poll-wake timer. When a loop parks at
    // a park with a polled stream, a timer fires every P seconds to resume it ({§exec-poll}). One
    // per worker (the tightest cadence); cleared/replaced on each park and on cancel.
    #parkTimers: Map<number, NodeJS.Timeout> = new Map();
    #pollTimers = new Map<number, ReturnType<typeof setTimeout>>();
    #pollBackoff = new Map<number, number>(); // {§exec-poll} — backoff step per worker
    // Per-worker drain-transition lock — see #withDrainLock (R4 / {§worker-lifecycle-single-drain}).
    #drainLocks = new Map<number, Promise<unknown>>();
    // {§worker-lifecycle-child-wake} — workers owed a wake: a child/stream conclusion fired while the worker was
    // mid-turn (not yet slept), so #wakeParkedWorker could not resume it. A child-worker conclusion is a
    // BOUNDED, lossless wake (a worker always concludes), so a hibernation awaiting one MUST return —
    // never deadlock. The drain honors the owed wake at the worker's next park, closing the conclude-
    // before-park race. (Only a live exec stream, unbounded absent a timeout, may hold a park open.)
    #owedWakes = new Set<number>();
    // {§worker-optimistic-settlement} — one non-sliding completion-wake batch
    // per worker. Durable conclusions and client events land before this gate;
    // only the parked loop's provider-dispatch requeue waits.
    #completionWakeGates = new Map<number, CompletionWakeGate>();

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
        // is NOT wired here — the engine's ruler below is {§tokenomics-agnostic-ruler}.)
        // Constructor ownership is the lifecycle boundary
        // ({§mimetype-owned-lifecycle}).
        this.#ownsMimetypes = mimetypes === undefined;
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
            createChild: async ({ workspaceId, parentWorkerId, parentLoopId, op, name, prompt, flags, origin }) => {
                const parentPolicy = await this.#providerPolicyForLoop(parentLoopId);
                const providerSpec = parentPolicy.childProviderSpec ?? parentPolicy.providerSpec;
                const workerName = WorkerName.assert(name);
                const workerId = op === "FORK"
                    ? await Fork.fork(this.#db, parentWorkerId, workerName)
                    : (await this.#db.fork_insert_worker.get<{ id: number }>({
                        workspace_id: workspaceId,
                        name: workerName,
                        parent_worker_id: parentWorkerId,
                        origin,
                    }))?.id;
                if (workerId === undefined) throw new Error("Branch worker insert returned no row");
                const loopId = await this.#enqueueFreshLoop({
                    workerId,
                    prompt,
                    providerSpec,
                    childProviderSpec: parentPolicy.childProviderSpec,
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
                await this.#settleCompletionWake(workspaceId, workerId, systemPrompt, false);
            },
            notify: (workspaceId, payload) => {
                this.#broadcast({ workspaceId }, "workspace/branch-batch", payload);
            },
        });
        this.#engine = new Engine({
            db, schemes: this.#schemes, mimetypes: this.#mimetypes,
            // {§tokenomics-agnostic-ruler} — the ONE model-facing token ruler (chars/2), NOT the
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
            // independently (the sister is its own worker). {§machine-processes}
            injectWorker: async ({ workspaceId, workerId, prompt, flags, parentLoopId }) => {
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const parentPolicy = parentLoopId === undefined
                    ? null
                    : await this.#providerPolicyForLoop(parentLoopId);
                const providerSpec = parentPolicy === null
                    ? resolveActiveAlias()
                    : parentPolicy.childProviderSpec ?? parentPolicy.providerSpec;
                if (providerSpec === null) throw new Error("injectWorker: active provider has no resolvable alias");
                const { action, loopId } = await this.inject({
                    workspaceId,
                    workerId,
                    prompt,
                    providerSpec,
                    ...(parentPolicy === null ? {} : { childProviderSpec: parentPolicy.childProviderSpec }),
                    systemPrompt,
                    ...(flags === undefined ? {} : { flags }),
                });
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
            const { workspaceId, ...proposal } = event;
            this.#broadcast({ workspaceId }, "loop/proposal", proposal);
        });
    }


    // {§methods-event-subscribe}. A transport module subscribes to the daemon's in-process
    // event source: it receives every workspace-scoped engine event as `(workspaceId, method, params)`
    // and fans out to its OWN clients — core emits, it never fans out for the module. Returns an
    // unsubscribe. `workspaceId` is the event's workspace, or null for a global event (e.g. workspace/created).
    // The engine and its events are core; the fan-out belongs to the module.
    subscribeToEvents(handler: (workspaceId: number | null, method: string, params: unknown) => void): () => void {
        this.#eventSubscribers.add(handler);
        return () => { this.#eventSubscribers.delete(handler); };
    }

    // {§methods-proposal-resolve} — proposal HITL. A transport module reads the stopped-world
    // proposals for a workspace (rendering each as a TOOL_CALL) and feeds back the human's decision. The
    // gate, validation, and applyResolution stay core (Engine.resolveProposal); the seam is the read +
    // the resolve, never the mechanism. `resolveProposal` throws for an unknown/already-resolved id.
    async pendingProposals(workspaceId: number): Promise<ProposalProjection[]> {
        const checkedWorkspaceId = ClientInput.assertId("pendingProposals", "workspaceId", workspaceId);
        return this.#engine.pendingProposals(checkedWorkspaceId);
    }

    resolveProposal(logEntryId: number, resolution: Omit<ProposalResolution, "result">): void {
        const checkedLogEntryId = ClientInput.assertId("resolveProposal", "logEntryId", logEntryId);
        const checkedResolution = ClientInput.assertProposalResolution("resolveProposal", resolution);
        this.#engine.resolveProposal(checkedLogEntryId, checkedResolution);
    }

    // {§methods-loop-run} — drive/steer a loop. The module supplies only workspace/worker/prompt;
    // the provider and the law-file system prompt are core's and stay inside. Returns immediately — the
    // loop runs async and its outcome arrives on the event source (loop/terminated). `cancelDrain` (public)
    // is the cancel hook. Both funnel through the unified `inject`, which owns the drain lifecycle.
    async runLoop(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: Partial<LoopFlags>; openPaths?: string[]; alias?: string; model?: string; childAlias?: string | null; childModel?: string }): Promise<SchemeResult & { action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        const workspaceId = ClientInput.assertId("runLoop", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("runLoop", "workerId", args.workerId);
        const prompt = ClientInput.assertPrompt("runLoop", args.prompt);
        const requestedMaxTurns = ClientInput.assertMaxTurns("runLoop", args.maxTurns);
        const openPaths = ClientInput.assertOpenPaths("runLoop", args.openPaths);
        const alias = ClientInput.assertOptionalSelector("runLoop", "alias", args.alias);
        const model = ClientInput.assertOptionalSelector("runLoop", "model", args.model);
        const childAlias = ClientInput.assertOptionalChildAlias("runLoop", args.childAlias);
        const childModel = ClientInput.assertOptionalSelector("runLoop", "childModel", args.childModel);
        if (childAlias === null && childModel !== undefined) {
            throw daemonFailure(
                "daemon:input",
                "child-provider-conflict",
                400,
                "childModel cannot accompany an inherited child provider policy.",
                { field: "childModel", recovery: "Omit childModel or select a child alias.", retryable: false },
            );
        }
        const flags = ClientInput.normalizeLoopFlags("runLoop", args.flags) as Partial<LoopFlags> | undefined;
        // {§methods-loop-run-model} — a client sends alias/model on every loop, so a
        // switch takes effect turn-to-turn. `model` (client-resolved <provider>/<model>) wins
        // over `alias`; neither → the boot default. Instantiation is cached, so ping-ponging
        // between two models is cheap, and an unresolvable alias/model fails loud here.
        const selection = await this.#resolveLoopProvider(alias, model);
        if (selection === null) {
            throw new OperationFailureError(Results.failure(
                "daemon:provider",
                "not-configured",
                501,
                "No provider is configured for this loop.",
                {},
                {
                    stage: "provider-selection",
                    recovery: "Select a configured model provider.",
                    retryable: false,
                },
            ));
        }
        // {§methods-loop-run-child-provider}
        const configuredChildAlias = childAlias === undefined && childModel === undefined
            ? process.env.PLURNK_MODEL_CHILD
            : childAlias;
        const childSelection = configuredChildAlias === null
            || (configuredChildAlias === undefined && childModel === undefined)
            ? null
            : await this.#resolveLoopProvider(configuredChildAlias, childModel);
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
        // {§machine-processes} — the model NEVER runs in a client-origin worker (its packets would carry
        // client-action rows). The module resolves the model worker via ensureModelWorker and passes it (or a
        // fork); a client worker here is a caller error, refused loudly rather than silently rehomed.
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number; origin: string }>({ id: workerId });
        if (target === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (target.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: target.workspace_id,
                    retryable: false,
                },
            );
        }
        if (target.origin === "client") {
            throw daemonFailure(
                "daemon:worker",
                "model-worker-required",
                409,
                `Worker ${workerId} is not a model worker.`,
                {
                    workerId,
                    recovery: "Select or create a model worker for this loop.",
                    retryable: false,
                },
            );
        }
        // {§operator-config-max-turns-ceiling} — the operator ceiling clamps a per-call maxTurns; a
        // seam caller must not bypass operator policy (inject only DEFAULTS from env, never clamps).
        const ceiling = Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "-1");
        const requested = requestedMaxTurns ?? ceiling;
        const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));
        const turnCeiling: TurnCeilingSelection = {
            effective: maxTurns,
            source: requestedMaxTurns === undefined ? "implicit" : "explicit",
        };
        const { action, loopId, turnSeq } = await this.inject({
            workspaceId,
            workerId,
            prompt,
            ...(flags !== undefined ? { flags } : {}),
            ...(openPaths !== undefined ? { openPaths } : {}),
            turnCeiling,
            providerSpec: selection,
            childProviderSpec: childSelection,
            systemPrompt,
        });
        return { status: 100, action, loopId, ...(turnSeq !== undefined ? { turnSeq } : {}) };
    }

    // {§methods-loop-run-model} — resolve a per-loop model override to a cached Provider. `model`
    // (<provider>/<model>, client-resolved) wins over a named `alias`; absent both, the
    // boot default. A named alias missing from the env cascade, or a malformed model spec, throws
    // legibly rather than silently running the wrong model.
    async #resolveLoopProvider(alias: string | undefined, model: string | undefined): Promise<ProviderAlias | null> {
        const requested = resolveLoopAlias(alias, model, parseAliasesFromEnv());
        if (requested === null && this.#provider === null) return null;
        const spec = requested ?? resolveActiveAlias();
        if (spec === null) {
            throw daemonFailure(
                "daemon:provider",
                "active-alias-unresolved",
                500,
                "The active provider has no resolvable alias.",
                { stage: "provider-selection", retryable: false },
            );
        }
        // Resolve eagerly so runLoop fails before enqueue when the provider
        // cannot be constructed. The drain later retrieves this cached handle
        // from the loop's durable spec at the claim boundary.
        try {
            await ProviderInstantiate.instantiateProvider(spec);
        } catch (cause) {
            if (cause instanceof OperationFailureError) throw cause;
            console.error(`Provider alias '${spec.alias}' could not be instantiated:`, cause);
            throw daemonFailure(
                "daemon:provider",
                "provider-unavailable",
                503,
                `Provider alias '${spec.alias}' is unavailable.`,
                {
                    alias: spec.alias,
                    provider: spec.provider,
                    model: spec.model,
                    stage: "provider-selection",
                    retryable: false,
                },
            );
        }
        return spec;
    }

    #parseProviderSpec(loopId: number, field: "provider_spec" | "child_provider_spec", encoded: string): ProviderAlias | null {
        let parsed: Partial<ProviderAlias> | null;
        try {
            parsed = JSON.parse(encoded) as Partial<ProviderAlias> | null;
        } catch {
            throw new Error(`loop ${loopId}: persisted ${field} is malformed`);
        }
        if (parsed === null) return null;
        if (typeof parsed.alias !== "string" || parsed.alias.length === 0
            || typeof parsed.provider !== "string" || parsed.provider.length === 0
            || typeof parsed.model !== "string" || parsed.model.length === 0
            || (parsed.baseUrl !== undefined && typeof parsed.baseUrl !== "string")) {
            throw new Error(`loop ${loopId}: persisted ${field} is invalid`);
        }
        return parsed as ProviderAlias;
    }

    async #providerPolicyForLoop(loopId: number): Promise<{ providerSpec: ProviderAlias; childProviderSpec: ProviderAlias | null }> {
        const row = await this.#db.drain_loop_provider_spec.get<{ provider_spec: string; child_provider_spec: string }>({ loop_id: loopId });
        if (row === undefined) throw new Error(`loop ${loopId}: provider selection row is missing`);
        const providerSpec = this.#parseProviderSpec(loopId, "provider_spec", row.provider_spec);
        if (providerSpec === null) {
            throw new Error(`loop ${loopId}: persisted provider selection is missing or invalid — refusing boot-default substitution`);
        }
        return {
            providerSpec,
            childProviderSpec: this.#parseProviderSpec(loopId, "child_provider_spec", row.child_provider_spec),
        };
    }

    async #providerSpecForLoop(loopId: number): Promise<ProviderAlias> {
        return (await this.#providerPolicyForLoop(loopId)).providerSpec;
    }

    async #providerForLoop(loopId: number): Promise<Provider> {
        return ProviderInstantiate.instantiateProvider(await this.#providerSpecForLoop(loopId));
    }

    async #assertLoopProvider(loopId: number, requested: ProviderAlias): Promise<void> {
        const selected = await this.#providerSpecForLoop(loopId);
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw daemonFailure(
                "daemon:provider",
                "loop-provider-conflict",
                409,
                `Loop ${loopId} uses provider alias '${selected.alias}', not '${requested.alias}'.`,
                {
                    loopId,
                    selectedAlias: selected.alias,
                    selectedModel: `${selected.provider}/${selected.model}`,
                    requestedAlias: requested.alias,
                    requestedModel: `${requested.provider}/${requested.model}`,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another provider.",
                    retryable: false,
                },
            );
        }
    }

    async #assertLoopChildProvider(loopId: number, requested: ProviderAlias | null): Promise<void> {
        const selected = (await this.#providerPolicyForLoop(loopId)).childProviderSpec;
        if (JSON.stringify(selected) !== JSON.stringify(requested)) {
            throw daemonFailure(
                "daemon:provider",
                "loop-child-provider-conflict",
                409,
                `Loop ${loopId} already has a different child provider policy.`,
                {
                    loopId,
                    selectedChildAlias: selected?.alias ?? null,
                    requestedChildAlias: requested?.alias ?? null,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before changing its child provider policy.",
                    retryable: false,
                },
            );
        }
    }

    async #assertLoopMaxTurns(loopId: number, requested: number | undefined): Promise<void> {
        if (requested === undefined) return;
        const durable = await this.#db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId });
        if (durable === undefined) throw new Error(`inject: loop ${loopId} has no durable turn ceiling`);
        if (durable.max_turns !== requested) {
            throw daemonFailure(
                "daemon:loop",
                "turn-ceiling-conflict",
                409,
                `Loop ${loopId} has turn ceiling ${durable.max_turns}, not ${requested}.`,
                {
                    loopId,
                    selectedMaximumTurns: durable.max_turns,
                    requestedMaximumTurns: requested,
                    stage: "loop-injection",
                    recovery: "Cancel or conclude the loop before selecting another turn ceiling.",
                    retryable: false,
                },
            );
        }
    }

    // {§methods-model-worker} — the workspace's model worker (created on first use), distinct from the client
    // worker so the model's packets never carry client-action rows. The module binds its threads to this.
    ensureModelWorker(workspaceId: number): Promise<number> {
        return Envelope.ensureModelWorker(
            this.#db,
            ClientInput.assertId("worker.ensure-model", "workspaceId", workspaceId),
        );
    }

    // {§methods-op-mirror} — execute parsed ops on behalf of a client, journaled as a
    // client-origin turn (the log is core's, a client op is a first-class citizen), dispatched through
    // the engine, then emitted as log/entry on the event source. One seam op backs the whole op_*
    // family (read/edit/copy/find/fold/look/move/open/send/exec); the module parses at its edge with the
    // grammar package and hands over the statement, then fans the emitted entry out to its own clients.
    async dispatchAsClient(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const workspaceId = ClientInput.assertId("operation.dispatch", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("operation.dispatch", "workerId", args.workerId);
        const { statement } = args;
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
        const workspaceId = ClientInput.assertId("operation.dispatch-batch", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("operation.dispatch-batch", "workerId", args.workerId);
        const { statements } = args;
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
            const { id: turnId } = await JournalTurn.insert(this.#db, loopId);
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

    // {§op-look} — the pure READ-projection query on the seam: resolve a READ through the
    // full scheme resolver and return its content, writing NO log row — the client's out-of-band
    // inspection primitive (the module rewrites LOOK→READ and parses at its edge, exactly like
    // dispatchClientAction). Its closed observation segment supplies the numeric loop coordinate
    // required by plugin context and relative log:/// addresses without impersonating an active
    // client lifecycle. It creates no turn or log row. Engine.look enforces READ-only.
    async look(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const workspaceId = ClientInput.assertId("operation.look", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("operation.look", "workerId", args.workerId);
        const { statement } = args;
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

    // {§methods-log-read} — a workspace's journal, the module's primary render input. The worker is
    // ownership-verified against the workspace (a workspace reads only its own workers — the model worker included,
    // {§methods-log-coordinate}); entries filter by loop/turn/since-id or the full L/T/S display coordinate. Core owns the
    // journal + the invariant; the module shapes the entries into AG-UI messages at its edge.
    async readLog(args: {
        workspaceId: number; workerId: number;
        loopId?: number; turnId?: number; sinceId?: number; limit?: number;
        loopSeq?: number; turnSeq?: number; sequence?: number;
    }): Promise<LogEntryWire[]> {
        const workspaceId = ClientInput.assertId("log.read", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("log.read", "workerId", args.workerId);
        const target = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (target === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (target.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: target.workspace_id,
                    retryable: false,
                },
            );
        }
        const coordinateFields = {
            loopId: args.loopId,
            turnId: args.turnId,
            sinceId: args.sinceId,
            loopSeq: args.loopSeq,
            turnSeq: args.turnSeq,
            sequence: args.sequence,
        };
        for (const [field, value] of Object.entries(coordinateFields)) {
            if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
                throw daemonFailure(
                    "daemon:log",
                    "coordinate-invalid",
                    400,
                    `Log coordinate field '${field}' is not a non-negative safe integer.`,
                    {
                        field,
                        value,
                        stage: "log-read",
                        recovery: "Use a non-negative integer coordinate.",
                        retryable: false,
                    },
                );
            }
        }
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
            throw daemonFailure(
                "daemon:log",
                "limit-invalid",
                400,
                `Log limit ${args.limit} is not a positive safe integer.`,
                {
                    field: "limit",
                    value: args.limit,
                    stage: "log-read",
                    recovery: "Use a positive integer log limit.",
                    retryable: false,
                },
            );
        }
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

    // {§methods} — the module's render surface beyond the journal. Thin delegations
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

    // {§client-display-capabilities} Core composes the installed family
    // declarations; interface modules expose this contracts-owned wire without
    // inventing presentation policy. `exec` is operation machinery, not an
    // addressable URI scheme; its runtime-tag scheme faces remain discoverable.
    async listClientDisplayCapabilities(): Promise<ClientDisplayCapabilities> {
        const schemes: ClientDisplayCapabilities = this.#schemes.list()
            .filter((scheme) => scheme !== "exec")
            .map((scheme) => {
                const glyph = this.#schemes.manifestFor(scheme)?.glyph;
                return {
                    kind: "scheme" as const,
                    scheme,
                    display: glyph === undefined ? {} : { glyph },
                };
            });
        const mimetypes: ClientDisplayCapabilities = (await this.#mimetypes.displayMetadata())
            .map(({ mimetype, glyph }) => ({
                kind: "mimetype" as const,
                mimetype,
                display: glyph.length === 0 ? {} : { glyph },
            }));
        return Validator.assertClientDisplayCapabilities([...schemes, ...mimetypes]);
    }

    listWorkspaces() { return Envelope.listWorkspaces(this.#db); }
    listWorkers(workspaceId: number) {
        return Envelope.listWorkersForWorkspace(
            this.#db,
            ClientInput.assertId("workspace.workers", "workspaceId", workspaceId),
        );
    }
    // {§methods-workspace-prompts}: root-conversation loop seeds, newest-first.
    listPrompts(workspaceId: number, limit?: number) {
        const checkedWorkspaceId = ClientInput.assertId("workspace.prompts", "workspaceId", workspaceId);
        const checkedLimit = ClientInput.assertLimit("workspace.prompts", limit);
        return Envelope.listPromptsForWorkspace(this.#db, checkedWorkspaceId, checkedLimit ?? 100);
    }
    async listMembers(workspaceId: number) {
        const checkedWorkspaceId = ClientInput.assertId("workspace.members", "workspaceId", workspaceId);
        const release = await this.#workspaceGate.acquireTurn(checkedWorkspaceId, 0);
        try {
            return await GitMembership.resolveMembershipEffects(this.#db, checkedWorkspaceId, undefined);
        } finally {
            release();
        }
    }
    listConstraints(workspaceId: number) {
        const checkedWorkspaceId = ClientInput.assertId("workspace.constraints", "workspaceId", workspaceId);
        return this.#db.crud_list_workspace_constraints.all<{ effect: string; glob: string }>({ workspace_id: checkedWorkspaceId });
    }
    workspaceDerivationStatus(workspaceId: number) {
        return this.#engine.workspaceDerivationStatus(
            ClientInput.assertId("workspace.derivation", "workspaceId", workspaceId),
        );
    }

    // {§methods-workspace-create}: the module owns protocol decoding; core validates the typed seam
    // inputs and owns the envelope, its reserved-name + name-uniqueness invariants,
    // membership resolution, warmWorkspaceDerivations, and the workspace/created emit. No connection state
    // (which client is on which workspace) lives here — that's the module's.
    async createWorkspace(args: { name?: string; projectRoot?: string | null; settings?: string | object; constraints?: Array<{ effect: string; glob: string }> }): Promise<ClientEnvelope> {
        // The seam fails hard on malformed semantic input so every module inherits one wall:
        // the settings bag
        // ({§operator-config-workspace-settings}),
        // constraints, and absolute projectRoot.
        const name = ClientInput.assertOptionalName("workspace.create", "name", args.name);
        const projectRoot = ClientInput.assertProjectRoot("workspace.create", args.projectRoot);
        const settings = ClientInput.parseSettings(args.settings);
        const constraints = ClientInput.parseConstraints(args.constraints);
        return observed( // {§observability-boundary}
            "workspace.create",
            {},
            async (span) => {
                const envelope = await Envelope.createClientEnvelope(this.#db, { name, projectRoot, settings });
                span.setAttribute("workspace.id", envelope.workspaceId);
                for (const { effect, glob } of constraints) {
                    await this.#db.crud_insert_workspace_constraint.run({ workspace_id: envelope.workspaceId, effect, glob });
                }
                if (constraints.length > 0) await GitMembership.resolveGitMembership(this.#db, envelope.workspaceId, undefined);
                await LoopDocs.materialize(this.#engine, this.#db, envelope.workspaceId);
                void this.#engine.warmWorkspaceDerivations(envelope.workspaceId).catch(() => {});
                this.#broadcast("all", "workspace/created", { id: envelope.workspaceId, name: envelope.workspaceName, projectRoot: envelope.projectRoot });
                return envelope;
            },
        );
    }

    async attachWorkspace(args: { workspaceId: number; workerId?: number; workerName?: string }): Promise<ClientEnvelope> {
        // attachToWorkspace owns the reserved-name + worker-ownership invariants; the seam just delegates + warms.
        const workspaceId = ClientInput.assertId("workspace.attach", "workspaceId", args.workspaceId);
        const workerId = args.workerId === undefined
            ? undefined
            : ClientInput.assertId("workspace.attach", "workerId", args.workerId);
        const workerName = ClientInput.assertOptionalWorkerName("workspace.attach", "workerName", args.workerName);
        const envelope = await Envelope.attachToWorkspace(this.#db, workspaceId, { workerId, workerName });
        void this.#engine.warmWorkspaceDerivations(envelope.workspaceId).catch(() => {});
        return envelope;
    }

    async renameWorkspace(workspaceId: number, name: string): Promise<{ id: number; name: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.rename", "workspaceId", workspaceId);
        const checkedName = ClientInput.assertOptionalName("workspace.rename", "name", name);
        if (checkedName === undefined) throw new Error("ClientInput.assertOptionalName accepted a required name as undefined");
        return { id: checkedWorkspaceId, name: await Envelope.updateWorkspaceName(this.#db, checkedWorkspaceId, checkedName) };
    }

    async constrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.constrain", "workspaceId", workspaceId);
        const release = await this.#workspaceGate.acquireTurn(checkedWorkspaceId, 0);
        try {
            ClientInput.assertConstraint("workspace.constrain", effect, glob);
            await this.#db.crud_insert_workspace_constraint.run({ workspace_id: checkedWorkspaceId, effect, glob });
            await GitMembership.resolveGitMembership(this.#db, checkedWorkspaceId, undefined);
            // Members may have just landed — begin warming now, but return the constraint response
            // immediately so prompts do not wait for the complete derivation corpus.
            void this.#engine.warmWorkspaceDerivations(checkedWorkspaceId).catch(() => {});
            return { effect, glob };
        } finally {
            release();
        }
    }

    async unconstrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        const checkedWorkspaceId = ClientInput.assertId("workspace.unconstrain", "workspaceId", workspaceId);
        const release = await this.#workspaceGate.acquireTurn(checkedWorkspaceId, 0);
        try {
            ClientInput.assertConstraint("workspace.unconstrain", effect, glob);
            await this.#db.crud_delete_workspace_constraint.run({ workspace_id: checkedWorkspaceId, effect, glob });
            await GitMembership.resolveGitMembership(this.#db, checkedWorkspaceId, undefined);
            void this.#engine.warmWorkspaceDerivations(checkedWorkspaceId).catch(() => {});
            return { effect, glob };
        } finally {
            release();
        }
    }

    // Contracts {§entry-read-result}: resolve through the scheme's address law,
    // then project one owner-scoped entry without exposing persistence columns.
    async readEntry(args: {
        workspaceId: number;
        workerId: number;
        target: string;
        channel?: string;
        offset?: number;
    }): Promise<EntryReadResult> {
        const workspaceId = ClientInput.assertId("entry.read", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("entry.read", "workerId", args.workerId);
        if (typeof args.target !== "string" || args.target.length === 0) {
            throw daemonFailure(
                "daemon:input",
                "target-invalid",
                400,
                "target is not a non-empty string.",
                {
                    context: "entry.read",
                    field: "target",
                    stage: "input-validation",
                    recovery: "Provide an entry URI.",
                    retryable: false,
                },
            );
        }
        const channel = ClientInput.assertOptionalChannel("entry.read", args.channel);
        const worker = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (worker === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (worker.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: worker.workspace_id,
                    retryable: false,
                },
            );
        }
        const release = await this.#workspaceGate.acquireTurn(workspaceId, workerId);
        try {
            let parsed;
            try {
                parsed = parsePath(args.target);
            } catch {
                parsed = null;
            }
            if (parsed === null || parsed.kind !== "url") {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "target-invalid",
                    400,
                    `The entry target '${args.target}' is not URL-shaped.`,
                    { entry: null },
                    {
                        target: args.target,
                        stage: "entry-read",
                        recovery: "Use a scheme://path target.",
                        retryable: false,
                    },
                ));
            }
            if (args.offset !== undefined && channel === undefined) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "offset-channel-required",
                    400,
                    "An entry offset requires a channel.",
                    { entry: null },
                    {
                        offset: args.offset,
                        stage: "entry-read",
                        recovery: "Select the channel to read from the offset.",
                        retryable: false,
                    },
                ));
            }
            if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "offset-invalid",
                    400,
                    `Entry offset ${args.offset} is not a non-negative safe integer.`,
                    { entry: null },
                    {
                        offset: args.offset,
                        stage: "entry-read",
                        recovery: "Use a non-negative integer offset.",
                        retryable: false,
                    },
                ));
            }
            if (parsed.username !== null || parsed.password !== null) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "userinfo-not-allowed",
                    400,
                    "Entry target URL userinfo is not allowed.",
                    { entry: null },
                    {
                        stage: "entry-read",
                        recovery: "Remove credentials from the entry URL.",
                        retryable: false,
                    },
                ));
            }
            const location = await this.#engine.resolveEntryAddress({
                workspaceId,
                workerId,
                target: parsed,
            });
            if (location === null) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "entry-not-found",
                    404,
                    "No visible entry exists at the requested target.",
                    { entry: null },
                    { target: args.target },
                ));
            }
            const row = await this.#db.entry_read_lookup.get<{ id: number }>({
                workspace_id: workspaceId,
                owner_id: location.ownerId,
                scheme: location.scheme,
                pathname: location.pathname,
            });
            if (row === undefined) {
                return entryReadResult(Results.failure(
                    "daemon:entry",
                    "entry-not-found",
                    404,
                    `No visible entry exists at ${location.target}.`,
                    { entry: null },
                    { target: location.target },
                ));
            }
            let channelRows: ChannelRow[];
            if (channel === undefined) {
                channelRows = await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id });
            } else {
                const r = await this.#db.entry_read_channel_slice.get<ChannelRow>({ entry_id: row.id, channel, offset: args.offset ?? 0 });
                if (r === undefined) {
                    const availableChannels = (await this.#db.entry_read_channels.all<ChannelRow>({ entry_id: row.id }))
                        .map(({ name }) => name);
                    return entryReadResult(Results.failure(
                        "daemon:entry",
                        "channel-not-found",
                        404,
                        `Channel #${channel} does not exist at ${location.target}.`,
                        { entry: null },
                        {
                            target: location.target,
                            requestedChannel: channel,
                            availableChannels,
                            ...(availableChannels.length === 0
                                ? {}
                                : { recovery: `Use one of the available channels: ${availableChannels.map((channel) => `#${channel}`).join(", ")}.` }),
                            retryable: false,
                        },
                    ));
                }
                channelRows = [r];
            }
            const channels: Record<string, ClientEntryChannel> = {};
            for (const c of channelRows) {
                channels[c.name] = {
                    content: c.content,
                    contentOffset: c.contentOffset,
                    contentLength: c.contentLength,
                    mimetype: c.mimetype,
                    tokens: c.tokens,
                    state: c.state,
                };
            }
            return entryReadResult({
                status: 200,
                entry: {
                    entryId: row.id,
                    target: location.target,
                    channels,
                },
            });
        } finally {
            release();
        }
    }

    // {§methods-conversation-worker}: a fresh conversation is a model-origin root worker with an empty private log.
    // AG-UI threads map to these workers while the workspace world remains shared ({§machine-processes}).
    async createConversationWorker(args: { workspaceId: number; name?: string }): Promise<{ workerId: number; workerName: string }> {
        const workspaceId = ClientInput.assertId("worker.create", "workspaceId", args.workspaceId);
        const name = ClientInput.assertOptionalWorkerName("worker.create", "name", args.name);
        const workspace = await this.#db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
        if (workspace === undefined) {
            throw daemonFailure(
                "daemon:workspace",
                "workspace-not-found",
                404,
                `Workspace ${workspaceId} does not exist.`,
                { workspaceId },
            );
        }
        if (name !== undefined) {
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) {
                throw daemonFailure(
                    "daemon:worker",
                    "name-conflict",
                    409,
                    `Worker name '${name}' is already in use in workspace ${workspaceId}.`,
                    { workspaceId, name, recovery: "Choose another worker name.", retryable: false },
                );
            }
        }
        const worker = await Envelope.createModelWorker(this.#db, workspaceId, name);
        return { workerId: worker.id, workerName: worker.name };
    }

    // {§worker-scheme-fork} — branch a worker's log while sharing the workspace world.
    // Core owns the workspace check and immutable worker-name admission.
    async forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }> {
        const workspaceId = ClientInput.assertId("worker.fork", "workspaceId", args.workspaceId);
        const workerId = ClientInput.assertId("worker.fork", "workerId", args.workerId);
        const name = ClientInput.assertOptionalWorkerName("worker.fork", "name", args.name);
        const owner = await this.#db.envelope_get_worker_by_id.get<{ workspace_id: number }>({ id: workerId });
        if (owner === undefined) {
            throw daemonFailure(
                "daemon:worker",
                "worker-not-found",
                404,
                `Worker ${workerId} does not exist.`,
                { workerId },
            );
        }
        if (owner.workspace_id !== workspaceId) {
            throw daemonFailure(
                "daemon:worker",
                "workspace-mismatch",
                409,
                `Worker ${workerId} does not belong to workspace ${workspaceId}.`,
                {
                    workerId,
                    workspaceId,
                    actualWorkspaceId: owner.workspace_id,
                    retryable: false,
                },
            );
        }
        if (name !== undefined) {
            const taken = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) {
                throw daemonFailure(
                    "daemon:worker",
                    "name-conflict",
                    409,
                    `Worker name '${name}' is already in use in workspace ${workspaceId}.`,
                    { workspaceId, name, recovery: "Choose another worker name.", retryable: false },
                );
            }
        }
        const branchWorkerId = await Fork.fork(this.#db, workerId, name);
        const branch = await this.#db.envelope_get_worker_by_id.get<{ name: string }>({ id: branchWorkerId });
        return { workerId: branchWorkerId, workerName: branch?.name ?? null, parentWorkerId: workerId };
    }

    async registerRuntime({ namespaceOwner, decl, executor, availability, scheme }: RuntimeRegistration): Promise<void> {
        if (typeof namespaceOwner !== "string" || namespaceOwner.trim().length === 0) {
            throw new Error("registerRuntime: namespaceOwner must be a non-empty string");
        }
        const runtime = RuntimeDeclaration.assert(decl, namespaceOwner);
        this.#engine.registerRuntime(runtime.name, {
            executor,
            namespaceOwner: { kind: "module", name: namespaceOwner },
            glyph: runtime.glyph ?? "",
            invocation: runtime.invocation,
            documentation: runtime.documentation ?? "",
            available: availability.available,
            detail: availability.detail,
        } satisfies RegistryEntry, scheme);
        if (this.#capabilitiesPublished) {
            for (const workspace of await Envelope.listWorkspaces(this.#db)) {
                await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
            }
        }
    }

    async registerScheme(name: string, handler: object): Promise<void> {
        this.#schemes.register(name, handler);
        if (this.#capabilitiesPublished) {
            await this.#schemes.ready();
            for (const workspace of await Envelope.listWorkspaces(this.#db)) {
                await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
            }
        }
    }

    registerModuleAction(name: string, handler: ModuleActionHandler): void {
        if (name.length === 0) throw new Error("registerModuleAction: action name must not be empty");
        if (this.#moduleActions.has(name)) throw new Error(`module action '${name}' is already registered`);
        this.#moduleActions.set(name, handler);
    }

    listModuleActions(): string[] {
        return [...this.#moduleActions.keys()].toSorted();
    }

    async invokeModuleAction(name: string, params: Readonly<Record<string, unknown>>): Promise<unknown> {
        const handler = this.#moduleActions.get(name);
        if (handler === undefined) throw new Error(`module action '${name}' is not registered`);
        return handler(params);
    }
    get engine(): Engine { return this.#engine; }
    get provider(): Provider | null { return this.#provider; }
    get schemes(): SchemeRegistry { return this.#schemes; }
    get mimetypes(): Mimetypes { return this.#mimetypes; }

    registerModule(module: DaemonModule<CoreSeam>): void {
        if (this.#started) throw new Error("registerModule: modules must be registered before daemon start");
        this.#modules.push(module);
    }

    async start(): Promise<void> {
        if (this.#started) throw new Error("daemon already started");
        this.#started = true;

        // Mimetypes owns its own discovery scan over @plurnk/plurnk-mimetypes-*
        // packages; pre-warm it so first index render doesn't pay the cost.
        await this.#mimetypes.ready();
        for (const name of await this.#mimetypes.skippedPackages()) {
            console.warn(`mimetype discovery: '${name}' is discovered but untrusted (PLURNK_PLUGINS_TRUSTED_ONLY); not registered`);
        }

        // Discover + probe the installed executor siblings, then hand the
        // registry to the engine for exec dispatch ({§exec-registry-resolves}). The
        // shell is the default runtime, so its executor must boot usable.
        const executors = await ExecutorRegistry.build({ defaultRuntime: "sh", cwd: this.#discoveryCwd });
        this.#engine.setExecutors(executors);
        // {§exec} — mint a scheme per runtime tag so exec output entries address by tag
        // authority (sh:///l/t/s). The "exec" scheme stays for the EXEC op dispatch.
        this.#schemes.registerRuntimeSchemes(executors);
        // Discover external @plurnk/plurnk-schemes-* siblings + register them
        // (agnostic, by plurnk.kind:"scheme"). They light up http://, etc. with
        // no further engine change — #run wraps their context in SchemeCtxImpl ({§plugin-discovery}).
        await this.#schemes.discoverExternal(this.#discoveryCwd);
        const setupSeam: ModuleSetupSeam = this;
        for (const module of this.#modules) {
            if (module.close !== undefined) this.#moduleClosers.push(module as StartedModule);
            await module.setup?.(setupSeam);
        }
        await this.#schemes.ready();

        // Reconcile the kernel-published documentation surface once per existing workspace.
        // Installed capabilities and operator configuration are now fully known; model loops
        // consume this workspace state but never republish it.
        for (const workspace of await Envelope.listWorkspaces(this.#db)) {
            await LoopDocs.materialize(this.#engine, this.#db, workspace.id);
        }
        this.#capabilitiesPublished = true;

        await this.#recoverLifecycle();

        // {§module-lifecycle} — the daemon opens no transport. Modules start their listeners only
        // after capability publication and durable lifecycle recovery are complete.
        for (const module of this.#modules) {
            const started = await module.start?.(this);
            if (started !== undefined && !this.#moduleClosers.includes(started)) {
                this.#moduleClosers.push(started);
            }
        }
    }

    async #recoverLifecycle(): Promise<void> {
        await this.#db.recovery_fail_active_loops.run({});
        await this.#db.recovery_settle_open_provider_requests.run({});
        await this.#db.recovery_fail_open_provider_attempts.run({});
        await this.#db.recovery_fail_ownerless_proposals.run({});
        await this.#db.recovery_error_orphan_subscription_channels.run({});
        await this.#db.recovery_fail_orphan_subscriptions.run({});
        await this.#db.recovery_resume_unblocked_parks.run({});
        await this.#branchBatches.recover();

        const orphanSources = await this.#db.recovery_orphan_prompt_sources.all<{
            loop_id: number;
            worker_id: number;
        }>({});
        for (const source of orphanSources) {
            await this.#reconcileOrphanedPrompts(source.worker_id, source.loop_id);
        }

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

        // Stop accepting external work immediately, but do not await listener
        // closure before cancelling active workers: an SSE connection may itself be
        // waiting for the worker cancellation that follows.
        const moduleClose = Promise.allSettled(
            this.#moduleClosers
                .toReversed()
                .map((module) => Promise.resolve().then(() => module.close())),
        );
        this.#moduleClosers = [];

        // Drain order: (1) abort in-flight loops via #activeDrains so
        // strike paths don't keep going, (2) await each drain's promise
        // to completion, (3) drain streaming schemes' background work
        // (exec spawn cleanup, channel writes). Only THEN close the DB
        // upstream — drain queries hit the DB right up until they exit.
        // Abort every worker's cancellation scope — stops in-flight loops AND the
        // streams (background execs) linked to them, so idle() doesn't block on
        // a long-running command. Covers workers whose drain already exited but
        // whose exec is still in flight.
        // Settle the stopped world FIRST: a drain paused at a pending proposal awaits a resolution
        // that will never arrive once clients are gone — allSettled(drains) below would deadlock
        // the stop forever (a daemon with a pending HITL proposal could not shut down).
        const derivationAbort = new DOMException("daemon stopping", "AbortError");
        this.#engine.cancelAllProposals("daemon_stopping");
        this.#engine.cancelDerivations(derivationAbort);
        this.#branchBatches.beginStop();
        for (const scope of this.#workerAborts.values()) { if (!scope.signal.aborted) scope.abort("daemon_stopping"); }
        for (const t of this.#pollTimers.values()) clearTimeout(t); // drop pending hibernation poll-wakes
        this.#pollBackoff.clear();
        this.#pollTimers.clear();
        // Cancel park-deadline timers before DB close; otherwise a late #wakeParkedWorker would run after
        // stop/db-close if left pending — an unhandled rejection (SqlRite closed) that abnormally
        // exits the worker under load. Symmetric with the poll-wakes above; both must be reaped.
        for (const t of this.#parkTimers.values()) clearTimeout(t);
        this.#parkTimers.clear();
        await this.#branchBatches.idle();
        const drainPromises = [...this.#activeDrains.values()].map((d) => d.promise);
        await Promise.allSettled(drainPromises);
        await Promise.allSettled([...this.#drainExitTasks]);
        const closeResults = await moduleClose;
        const [streamingResult] = await Promise.allSettled([this.#drainStreamingSchemes()]);
        const [derivationResult] = await Promise.allSettled([
            this.#engine.drainDerivations(derivationAbort), // active workspace warms settle before the db closes upstream
        ]);
        const mimetypeResults = this.#ownsMimetypes
            ? await Promise.allSettled([this.#mimetypes.dispose()])
            : [];
        const [schemeResult] = await Promise.allSettled([this.#schemes.close()]);
        const closeErrors = [...closeResults, streamingResult, derivationResult, ...mimetypeResults, schemeResult]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .flatMap((result) => result.reason instanceof AggregateError
                ? [...result.reason.errors]
                : [result.reason]);
        if (closeErrors.length > 0) throw new AggregateError(closeErrors, "daemon shutdown failed");
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
     * they update channel content or state. SPEC {§notifications}.
     */
    notifyStreamEvent(workspaceId: number, event: StreamEventPayload): void {
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
     *   - Active drain: writes the next prompt:///<loop>/<N> entry via
     *     Engine.inject. The current loop publishes it at its next
     *     turn. Returns immediately with {action: "injected_next_turn"}.
     *   - No active drain: enqueues a fresh loop with the prompt at
     *     status=100, starts a drain. Returns the drain promise so the
     *     caller can await full completion.
     *
     * Both `runLoop` and wake-on-completion go through this method
     * ({§actor-boundary-passive-wake}).
     */
    // {§methods-loop-run-fold-consistency} — a folded prompt cannot reconfigure its loop.
    async #assertFoldPosture(workerId: number, flags: Partial<LoopFlags> | undefined, loopId: number): Promise<void> {
        if (flags === undefined || Object.keys(flags).length === 0) return;
        const effective = await LoopFlagsReader.read(this.#db, loopId);
        const requested = Object.entries(flags) as Array<[keyof LoopFlags, LoopFlags[keyof LoopFlags] | undefined]>;
        const conflicts = requested
            .filter(([key, value]) => value !== undefined && effective[key] !== value)
            .map(([key, value]) => `${key}: ${JSON.stringify(effective[key])} -> ${JSON.stringify(value)}`);
        if (conflicts.length > 0) {
            throw daemonFailure(
                "daemon:loop",
                "loop-flags-conflict",
                409,
                "The requested loop flags differ from the active loop flags.",
                {
                    workerId,
                    loopId,
                    conflicts,
                    stage: "loop-injection",
                    recovery: "Cancel the active loop before changing flags, or omit flags to keep its current posture.",
                    retryable: false,
                },
            );
        }
    }

    async inject(args: {
        workspaceId: number; workerId: number; prompt: string;
        providerSpec: ProviderAlias; systemPrompt: string;
        childProviderSpec?: ProviderAlias | null;
        turnCeiling?: TurnCeilingSelection; flags?: Partial<LoopFlags>; openPaths?: string[];
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
            const active = await this.#db.drain_current_loop_for_worker.get<{ id: number }>({ worker_id: workerId });
            if (active !== undefined) {
                await this.#assertFoldPosture(workerId, args.flags, active.id); // compare with the exact durable loop
                await this.#assertLoopProvider(active.id, args.providerSpec);
                if (args.childProviderSpec !== undefined) await this.#assertLoopChildProvider(active.id, args.childProviderSpec);
                await this.#assertLoopMaxTurns(
                    active.id,
                    args.turnCeiling?.source === "explicit" ? args.turnCeiling.effective : undefined,
                );
            }
            const result = await this.#engine.inject(workerId, prompt, args.openPaths ?? []);
            if (result !== null) {
                return { action: "injected_next_turn", loopId: result.loopId, turnSeq: result.turnSeq };
            }
        }

        // {§worker-lifecycle-wake-requeue-not-terminal} — a worker parked at 202 resumes that loop in place:
        // is a wake edge like a stream/child conclusion, not a fresh loop that orphans the parked one
        // (which would leave the worker non-quiescent forever). engine.inject writes the message as the
        // slept loop's next-turn prompt (the directed message — distinct from the env door, which
        // resumes promptless); then re-queue + drain it. {§worker-lifecycle-wake-liveness}.
        if (!this.#activeDrains.has(workerId)) {
            const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
            if (slept !== undefined) {
                await this.#assertFoldPosture(workerId, args.flags, slept.id); // resume drops nothing silently
                await this.#assertLoopProvider(slept.id, args.providerSpec);
                if (args.childProviderSpec !== undefined) await this.#assertLoopChildProvider(slept.id, args.childProviderSpec);
                await this.#assertLoopMaxTurns(
                    slept.id,
                    args.turnCeiling?.source === "explicit" ? args.turnCeiling.effective : undefined,
                );
                const injected = await this.#engine.inject(workerId, prompt, args.openPaths ?? []);
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
            childProviderSpec: args.childProviderSpec ?? null,
            maxTurns: args.turnCeiling?.effective,
            flags: args.flags,
            openPaths: args.openPaths,
        });

        // Guarantee a drain claims the loop we just enqueued. #ensureDrain runs its
        // check-and-start UNDER the per-worker drain lock ({§worker-lifecycle-single-drain}),
        // serialized against a draining sibling's teardown relinquish so the two can't
        // both register a drain (R4). A live drain re-claims the loop in its own
        // iteration or its lock-held exit re-claim, so it's never stranded.
        // firstLoopPromise is present only when THIS call started the drain — runLoop
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
        childProviderSpec: ProviderAlias | null;
        maxTurns?: number;
        flags?: Partial<LoopFlags>;
        openPaths?: string[];
    }): Promise<number> {
        // {§worker-lifecycle-single-drain}: sequence allocation and insertion
        // are one queue mutation; another accepted prompt cannot claim the gap.
        return this.#withDrainLock(args.workerId, async () => {
            const seqRow = await this.#db.loop_run_next_sequence.get<{ next: number }>({
                worker_id: args.workerId,
            });
            if (seqRow === undefined) throw new Error("enqueueFreshLoop: next-sequence query returned no row");
            const loopRow = await this.#db.drain_enqueue_loop.get<{ id: number }>({
                worker_id: args.workerId,
                sequence: seqRow.next,
                prompt: args.prompt,
                provider_spec: JSON.stringify(args.providerSpec),
                child_provider_spec: JSON.stringify(args.childProviderSpec),
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
        });
    }

    /**
     * Start a drain for the given worker. The drain claims queued loops via
     * drain_claim_next_loop (atomic 100→102 flip), executes each via
     * Engine.runLoop, and re-checks. Stream-aware: when the queue is empty
     * but the worker has active subscriptions, the drain parks on a
     * #drainPokes signal — wake-on-completion → inject() wakes it. Drain
     * exits when queue is empty AND no active subscriptions remain.
     *
     * Returns both `firstLoopPromise` (resolves once the first loop the
     * drain processes completes — used by runLoop to give the caller a
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
            let currentLoopId: number | null = null; // the loop being drained — for abort→499 settlement
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
                    // {§methods-loop-run-model} — provider identity belongs to the claimed loop, not the
                    // drain that happened to claim it. A drain can consume multiple
                    // queued loops; resolve each durable selection at this boundary.
                    const provider = await this.#providerForLoop(loopRow.id);
                    const onDispatch = (logEntryId: number): void => {
                        // {§methods-event-subscribe} — a log-broadcast failure must never crash the drain.
                        void (async () => {
                            const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                            this.#broadcast({ workspaceId }, "log/entry", { entry });
                        })().catch((e: unknown) => console.error("log/entry broadcast failed:", e instanceof Error ? e.message : String(e)));
                    };
                    const result = await observed( // {§observability-boundary}
                        "loop.run",
                        { workspaceId, workerId, "loop.id": loopRow.id },
                        async (span) => {
                            const loopResult = await this.#engine.runLoop({
                                provider, workspaceId, workerId, loopId: loopRow.id, maxTurns: loopRow.max_turns,
                                messages: [
                                    { role: "system", content: systemPrompt },
                                    { role: "user", content: loopRow.prompt },
                                ],
                                origin: "model",
                                onDispatch,
                                signal: controller.signal,
                            });
                            span.setAttribute("status", loopResult.result.status);
                            recordCounter(LOOP_TERMINALS, { status: loopResult.result.status });
                            return loopResult;
                        },
                    );
                    if (result.result.status === 202) {
                        // The loop slept via SEND signal 202 — suspended, not terminated. Leave it at 202
                        // (resumable); no loop/terminated, no orphan-reconcile. A stream conclusion
                        // (#handleWakeWorker) re-queues it; and if it holds a polled stream, a poll timer
                        // wakes it every P to inspect ({§exec-poll}). {§worker-lifecycle-wake-liveness}.
                        void this.#schedulePollWake(workspaceId, workerId, systemPrompt).catch((err: unknown) => console.error("poll-wake scheduling failed:", err instanceof Error ? err.message : String(err)));
                        // {§send-premature-terminate}/scoped SEND signal 202 — the park deadline:
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
                        // Honor an OWED wake ({§worker-lifecycle-child-wake}): a child/stream concluded while
                        // this worker was mid-turn, before it slept — resume in place rather than park blind,
                        // so a worker hibernation always returns. The loop is 202 here; reset to
                        // claimable and the drain re-runs it on the next claim below.
                        if (this.#owedWakes.delete(workerId)) {
                            await this.#lifecycle.wake(loopRow.id);
                            currentLoopId = null;
                            continue;
                        }
                        // The loop is blocked at 202 on a live obligation ({§wait-obligation-matrix});
                        // that obligation's conclusion is its wake edge (the owed-wake above covers the
                        // conclude-before-block race). An idle wait never reaches here — it concluded at dispatch.
                        currentLoopId = null;
                        continue;
                    }
                    this.#owedWakes.delete(workerId); // the loop concluded (non-202) — no park to honor a held wake at
                    const [usage, attributions, turnIds] = await Promise.all([
                        this.#engine.loopUsage(loopRow.id),
                        this.#engine.loopAttributions(loopRow.id),
                        this.#lifecycle.turnIds(loopRow.id),
                    ]);
                    this.#broadcast({ workspaceId }, "loop/terminated", {
                        workerId,
                        loopId: loopRow.id,
                        result: result.result,
                        hitMaxTurns: result.hitMaxTurns,
                        turnIds,
                        usage,
                        attributions,
                    });
                    loopsDrained++;
                    const loopResult: DrainLoopResult = {
                        loopId: loopRow.id,
                        turnIds,
                        result: result.result,
                        hitMaxTurns: result.hitMaxTurns,
                        usage,
                        attributions,
                    };
                    lastResult = loopResult;
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst(loopResult);
                    }
                    // A next-turn prompt this loop ended before consuming (a
                    // wake conclusion or a runLoop-while-active prompt) is promoted to
                    // a fresh queued loop so it's never silently dropped.
                    await this.#reconcileOrphanedPrompts(workerId, loopRow.id);
                    currentLoopId = null;
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // {§methods-loop-cancel} — loop.cancel / shutdown aborted the live drain. A cancellation
                    // is the loop's TERMINAL state (499), delivered via loop/terminated (runLoop no
                    // longer blocks to return it). A genuine error rejects firstLoopPromise.
                    let usage: LoopUsage = {
                        accounting: aggregateProviderAccounting([]),
                        contextTokens: null,
                        promptBudget: null,
                        meta: {},
                    };
                    let attributions: string[] = [];
                    const message = ErrorDetail.preview(controller.signal.reason ?? "user_cancelled")
                        || "no reason was supplied";
                    if (currentLoopId !== null) {
                        // {§methods-loop-cancel}/{§worker-lifecycle-terminal-result} —
                        // persist the exact 499 cancellation result before broadcasting it.
                        const cancelled = await this.#lifecycle.finish(
                            currentLoopId,
                            Results.failure(
                                "lifecycle:cancel",
                                "loop-cancelled",
                                499,
                                `The loop was cancelled: ${message}.`,
                                {},
                                {
                                    reason: message,
                                    stage: "loop",
                                    retryable: false,
                                },
                            ),
                            { terminatedBy: "cancel" },
                        );
                        [usage, attributions] = await Promise.all([
                            this.#engine.loopUsage(currentLoopId),
                            this.#engine.loopAttributions(currentLoopId),
                        ]);
                        if (cancelled !== null) {
                            this.#broadcast({ workspaceId }, "loop/terminated", {
                                workerId,
                                loopId: currentLoopId,
                                result: cancelled,
                                hitMaxTurns: false,
                                turnIds: await this.#lifecycle.turnIds(currentLoopId),
                                usage,
                                attributions,
                            });
                        }
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst({
                            loopId: currentLoopId ?? 0,
                            turnIds: [],
                            result: currentLoopId === null
                                ? Results.failure(
                                    "lifecycle:cancel",
                                    "loop-cancelled",
                                    499,
                                    `The loop was cancelled: ${message}.`,
                                    {},
                                    {
                                        reason: message,
                                        stage: "loop",
                                        retryable: false,
                                    },
                                )
                                : await this.#lifecycle.result(currentLoopId)
                                    ?? Results.failure(
                                        "lifecycle:cancel",
                                        "loop-cancelled",
                                        499,
                                        `The loop was cancelled: ${message}.`,
                                        {},
                                        {
                                            reason: message,
                                            stage: "loop",
                                            retryable: false,
                                        },
                                    ),
                            hitMaxTurns: false,
                            usage,
                        });
                    }
                } else {
                    // {§worker-lifecycle-terminal-result} — a non-abort drain
                    // failure becomes an exact durable 500 and terminal notification;
                    // daemon diagnostics retain the complete caught error.
                    console.error(`drain error (workspace ${workspaceId}, worker ${workerId}, loop ${currentLoopId ?? "?"}):`, err);
                    if (currentLoopId !== null) {
                        const failure = err instanceof OperationFailureError
                            ? err.result
                            : Results.failure(
                                "daemon:drain",
                                "loop-threw",
                                500,
                                "The loop failed outside its operation result contract.",
                                {},
                                {
                                    stage: "loop",
                                    retryable: false,
                                },
                            );
                        const settled = await this.#lifecycle.finish(currentLoopId, failure)
                            ?? await this.#lifecycle.result(currentLoopId);
                        if (settled === null) {
                            throw new Error(`drain could not settle loop ${currentLoopId}`, { cause: err });
                        }
                        const [usage, attributions] = await Promise.all([
                            this.#engine.loopUsage(currentLoopId),
                            this.#engine.loopAttributions(currentLoopId),
                        ]);
                        this.#broadcast({ workspaceId }, "loop/terminated", {
                            workerId,
                            loopId: currentLoopId,
                            result: settled,
                            hitMaxTurns: false,
                            turnIds: await this.#lifecycle.turnIds(currentLoopId),
                            usage,
                            attributions,
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
        // Topology join ({§worker-loop-lifecycle}): when this drain exits having CONCLUDED the worker, wake its parent
        // if parked. Runs after the drain fully tears down (settled promise) so the quiescence check sees
        // final state; speculative (#onDrainExit no-ops unless the worker concluded AND the parent is parked).
        const drainExitTask = drainPromise.then(
            () => this.#onDrainExit(workspaceId, workerId, systemPrompt),
            () => this.#onDrainExit(workspaceId, workerId, systemPrompt),
        );
        this.#drainExitTasks.add(drainExitTask);
        void drainExitTask.catch((err: unknown) => {
            console.error(`parent wake after worker ${workerId} settlement failed:`, err);
        }).finally(() => {
            this.#drainExitTasks.delete(drainExitTask);
        });
        // Swallow unhandled rejections (drain aborts with no awaiter); the
        // error already surfaced via firstLoopPromise or was logged inside.
        drainPromise.catch(() => {});
        firstLoopPromise.catch(() => {});
        return { firstLoopPromise, drainPromise };
    }

    // Per-worker drain-transition lock (R4 / {§worker-lifecycle-single-drain}). #ensureDrain's
    // start and a drain's teardown relinquish both run under it, serialized, so the two
    // can't interleave and register two drains for one worker. The critical section is the
    // registry decision only (never a loop's work) — a sub-ms hop at drain boundaries.
    // A promise-chain mutex: each caller awaits the prior holder; the tail self-prunes
    // when idle so the Map stays bounded to workers mid-transition.
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

    // After a loop terminates, promote every next-turn frame it never consumed
    // into one source-keyed queued loop. The first frame occupies the loop seed;
    // later frames retain separate prompt entries and publish in the same turn.
    // Re-entry and boot recovery complete that same queued identity.
    async #reconcileOrphanedPrompts(workerId: number, endedLoopId: number): Promise<void> {
        await this.#withDrainLock(workerId, async () => {
            const endedSeq = (await this.#db.engine_loop_sequence.get<{ sequence: number }>({ loop_id: endedLoopId }))?.sequence ?? endedLoopId;
            const prefix = promptLoopPrefix(endedSeq);
            const frames = await this.#db.drain_orphaned_prompts_for_loop.all<{
                body: string;
                flags: string;
                provider_spec: string;
                child_provider_spec: string;
                max_turns: number;
                open_paths: string | null;
            }>({ loop_id: endedLoopId, owner_id: workerId, pattern: `${prefix}%`, prefix_len: prefix.length });
            const first = frames[0];
            if (first === undefined) return;
            const seqRow = await this.#db.loop_run_next_sequence.get<{ next: number }>({ worker_id: workerId });
            if (seqRow === undefined) throw new Error("reconcileOrphanedPrompts: next-sequence query returned no row");
            const recovery = await this.#db.drain_enqueue_orphan_recovery_loop.get<{
                id: number;
                sequence: number;
                status: number;
            }>({
                worker_id: workerId,
                sequence: seqRow.next,
                prompt: first.body,
                flags: first.flags,
                provider_spec: first.provider_spec,
                child_provider_spec: first.child_provider_spec,
                max_turns: first.max_turns,
                open_paths: first.open_paths ?? "[]",
                orphan_source_loop_id: endedLoopId,
            });
            if (recovery === undefined) throw new Error("reconcileOrphanedPrompts: enqueue returned no row");
            if (recovery.status !== 100) return;
            const moved = await this.#db.drain_rehome_orphaned_prompt_frames.all<{ id: number; pathname: string }>({
                owner_id: workerId,
                source_loop_id: endedLoopId,
                source_pattern: `${prefix}%`,
                source_prefix_len: prefix.length,
                target_prefix: promptLoopPrefix(recovery.sequence),
            });
            if (moved.length !== frames.length) {
                throw new Error(`reconcileOrphanedPrompts: expected to re-home ${frames.length} frames, moved ${moved.length}`);
            }
        });
    }

    // The worker's cancellation scope — lazily created, and replaced once aborted
    // so a later runLoop gets a live signal. The drain and the execs its loops
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
            const [usage, attributions] = await Promise.all([
                this.#engine.loopUsage(loopId),
                this.#engine.loopAttributions(loopId),
            ]);
            this.#broadcast({ workspaceId: row.workspace_id }, "loop/terminated", {
                workerId: targetWorkerId,
                loopId,
                result,
                hitMaxTurns: false,
                turnIds: await this.#lifecycle.turnIds(loopId),
                usage,
                attributions,
            });
        }
    }

    async #cancelWorkerTree(workerId: number, reason: string): Promise<void> {
        await this.#cancelTree(workerId, reason, true);
    }

    /**
     * Cancel the worker's in-flight work (loop.cancel). One abort, one scope: the
     * worker signal stops the running loop's turn generation AND tears down every
     * stream linked to it — a background exec that outlived its loop, or even a
     * spawn that registers after this abort (it self-aborts against the aborted
     * signal). Returns cancelled iff there was process-local work; durable
     * unresolved loops in the worker tree are terminalized independently.
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
    // worker signal. Duck-typed like #drainStreamingSchemes.
    #workerHasActiveStreams(workerId: number): boolean {
        const exec = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean } | undefined;
        return exec?.hasActiveSpawns?.(workerId) ?? false;
    }

    // The contract-routed reap ({§worker-lifecycle-total-reap}): durable rows enumerate
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
     * subscription closes. A parked loop resumes in place; an active loop
     * observes the channel transition at its next turn boundary. No synthetic
     * prompt or replacement loop is created.
     *
     * Skipped on result.status=499 (aborted): the model already knows about
     * its own SEND signal 499, and a forcefully-cancelled loop's spawn-abort must
     * not resurrect the worker.
     */
    async #handleWakeWorker(payload: WakeWorkerPayload): Promise<void> {
        const { entryOwnerId, ...wake } = payload;
        const conclusion = { ...wake, workerId: entryOwnerId };
        // {§search-gate} — settle the dedup registration: promote on a 200 conclusion, drop on
        // failure (a dead search must never serve as a duplicate). No-op for non-search streams.
        this.#engine.searchGate.settle(payload.target.replace(/^[a-z+.-]+:\/\//, "/").replace(/^\/+/, "/"), payload.result.status);
        // Aborted streams don't wake — the abort was deliberate.
        if (payload.result.status === 499) {
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...conclusion, wakeAction: "skipped-aborted",
            });
            return;
        }

        // No resurrection ({§worker-lifecycle-no-resurrection}): a non-499 completion whose
        // worker was cancelled (idle + its scope aborted) must not start a fresh drain —
        // the cancel was deliberate. The deliverable is already in the channel/log and
        // surfaces as a `collect` environment delta ({§env-delta}) if the worker is read or
        // resumed; we just don't inject a turn. (An active worker folds the wake into its
        // next turn via inject below; a resumed worker is active, never aborted, so it is
        // unaffected.)
        const scope = this.#workerAborts.get(payload.workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(payload.workerId)) {
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...conclusion, wakeAction: "skipped-cancelled",
            });
            return;
        }

        try {
            const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");

            // A slept (202) loop means the worker parked via SEND signal 202 → resume it in place: re-queue
            // it (202→100) so the drain re-claims and CONTINUES it (seq>1 → no re-foist). Checked
            // FIRST: the slept status is the worker's true disposition regardless of a draining
            // sibling mid-teardown (the #ensureDrain lock serializes the re-claim). No fresh loop,
            // no summary-as-prompt — the resumed loop reads the concluded stream's own state from
            // the manifest. {§worker-lifecycle-wake-liveness}.
            const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: payload.workerId });
            if (slept !== undefined) {
                // {§worker-optimistic-settlement} — publish this conclusion now,
                // then let the worker-local gate coalesce only the provider
                // dispatch. Concurrent stream/child callbacks join that one gate.
                void this.#settleCompletionWake(
                    payload.workspaceId,
                    payload.workerId,
                    systemPrompt,
                    false,
                ).catch((err: unknown) => {
                    console.error("completion wake settlement failed:", err instanceof Error ? err.message : String(err));
                });
                this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                    ...conclusion, wakeAction: "resumed-loop", wakeLoopId: slept.id,
                });
                return;
            }

            // No slept loop. A live loop surfaces the concluded stream ambiently via the
            // environment-observation injector ({§exec-stream}) on its next turn — there is no prompt
            // to inject and NO task to overwrite. The obsolete "automated environment update"
            // synthesis (which clobbered the model's actual goal) is retired; just tell the client.
            if (this.#activeDrains.has(payload.workerId)) {
                this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                    ...conclusion, wakeAction: "no-op-active-loop",
                });
                return;
            }

            // No slept loop, no active drain — nothing to resume (e.g. a SEND-200-done worker whose
            // streams were swept). Surface the conclusion without opening a loop.
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...conclusion, wakeAction: "no-loop",
            });
        } catch (err) {
            console.error("wake-on-completion setup failed:", err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * grammar 0.74.20 EXEC `<T,P>` — schedule a hibernation poll-wake. Called when a loop parks at
     * a park; if the worker holds an open polled stream, arm a timer for its tightest cadence P that
     * resumes the slept loop so the model inspects progress. While the loop is ACTIVE there is no
     * poll work — ambient folded stream deltas already surface progress ({§exec-stream}); the wake
     * matters only across hibernation. A wake-edge-less 202 (no polled stream) gets no timer. {§exec-poll}
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
        // {§exec-poll} — a positive explicit cadence wins, zero opts out,
        // and an absent cadence uses the worker's exponential-backoff step.
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
        // Floored by the optimistic settlement cap so a `<…,1>` cannot wake a
        // parked loop faster than the preceding turn's settlement scale.
        const optimisticWaitMs = readOptimisticSettlementMs();
        const timer = setTimeout(() => {
            this.#pollTimers.delete(workerId);
            void this.#wakeParkedWorker(workspaceId, workerId, systemPrompt);
        }, Math.max(delayMs, optimisticWaitMs));
        timer.unref();
        this.#pollTimers.set(workerId, timer);
    }

    /** Resume `workerId`'s slept (202) loop in place — the same 202→100 resume #handleWakeWorker uses, minus a
     *  wake payload. The shared wake primitive: a poll cadence ({§exec-poll}), a watched stream concluding,
     *  or a child worker finishing ({§worker-loop-lifecycle} topology join) all call this. A no-op if the worker was
     *  cancelled or isn't actually parked (no slept loop) — so calling it speculatively is safe. */
    async #wakeParkedWorker(workspaceId: number, workerId: number, systemPrompt: string, oweIfActive = true): Promise<void> {
        if (!this.#started) return;
        const scope = this.#workerAborts.get(workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(workerId)) return; // cancelled — no resurrection
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            // Not parked. If a drain is still ACTIVE, the worker is mid-turn and about to park — the
            // conclusion that fired this wake arrived before the 202 committed (the conclude-before-park
            // race). Owe the wake: the drain honors it at park so a worker hibernation never deadlocks.
            // (No active drain → already concluded/running; nothing to wake.)
            if (this.#activeDrains.has(workerId)) {
                if (oweIfActive) this.#owedWakes.add(workerId);
            }
            return;
        }
        const woke = await this.#lifecycle.wake(slept.id);
        if (!woke) return;
        const started = await this.#ensureDrain({
            workspaceId, workerId, systemPrompt,
        });
        started?.drainPromise?.catch((err: unknown) => {
            if (this.#started) {
                console.error("wake-parked resume drain failed:", err instanceof Error ? err.message : String(err));
            }
        });
    }

    async #workerHasLiveObligation(workerId: number): Promise<boolean> {
        const [openSubscriptions, liveChild] = await Promise.all([
            this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId }),
            this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId }),
        ]);
        return openSubscriptions.length > 0 || liveChild !== undefined;
    }

    #settleCompletionWake(
        workspaceId: number,
        workerId: number,
        systemPrompt: string,
        oweIfActive = true,
    ): Promise<void> {
        const existing = this.#completionWakeGates.get(workerId);
        if (existing !== undefined) {
            existing.conclusions++;
            existing.poke.resolve();
            return existing.promise;
        }

        const completed = Promise.withResolvers<void>();
        const gate: CompletionWakeGate = {
            conclusions: 1,
            poke: Promise.withResolvers<void>(),
            promise: completed.promise,
        };
        this.#completionWakeGates.set(workerId, gate);
        void this.#runCompletionWake(
            workspaceId,
            workerId,
            systemPrompt,
            oweIfActive,
            gate,
        ).then(completed.resolve, completed.reject).finally(() => {
            if (this.#completionWakeGates.get(workerId) === gate) {
                this.#completionWakeGates.delete(workerId);
            }
        });
        return gate.promise;
    }

    async #runCompletionWake(
        workspaceId: number,
        workerId: number,
        systemPrompt: string,
        oweIfActive: boolean,
        gate: CompletionWakeGate,
    ): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            this.#releaseCompletionWake(workerId, gate);
            return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, oweIfActive);
        }

        const timeoutMs = readOptimisticSettlementMs();
        if (timeoutMs === 0 || !(await this.#workerHasLiveObligation(workerId))) {
            this.#releaseCompletionWake(workerId, gate);
            return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, false);
        }

        return observed(
            "worker.wake.settlement",
            { "window.ms": timeoutMs },
            async (span) => {
                const startedAt = performance.now();
                const signal = this.#workerAborts.get(workerId)?.signal;
                const deadline = delay(timeoutMs, "deadline" as const, { signal, ref: false })
                    .catch((cause: unknown) => {
                        if (signal?.aborted === true) return "cancelled" as const;
                        throw cause;
                    });
                let release: "quiescent" | "deadline" | "cancelled" = "quiescent";
                while (await this.#workerHasLiveObligation(workerId)) {
                    const poke = gate.poke;
                    const outcome = await Promise.race([
                        poke.promise.then(() => "arrival" as const),
                        deadline,
                    ]);
                    if (outcome === "arrival") {
                        if (gate.poke === poke) gate.poke = Promise.withResolvers<void>();
                        continue;
                    }
                    release = outcome;
                    break;
                }
                span.setAttribute("release", release);
                span.setAttribute("conclusions", gate.conclusions);
                span.setAttribute("elapsed.ms", Math.round(performance.now() - startedAt));
                this.#releaseCompletionWake(workerId, gate);
                if (release === "cancelled") return;
                return this.#wakeParkedWorker(workspaceId, workerId, systemPrompt, false);
            },
        );
    }

    #releaseCompletionWake(workerId: number, gate: CompletionWakeGate): void {
        if (this.#completionWakeGates.get(workerId) === gate) {
            this.#completionWakeGates.delete(workerId);
        }
    }

    /** A worker's drain exited. If the worker truly CONCLUDED — no 202-blocked loop, no open stream — then
     *  wake its PARENT in place if the parent is blocked on the join (the structured-concurrency join — a
     *  child finishing is the wake edge for a parent that waited on it, {§worker-lifecycle-child-wake}). A worker
     *  blocked at 202, or still holding a stream, is NOT concluded — its own wake edges drive it, not this.
     *  The parent reads the child's deliverable from its own log (the {§worker-scheme-collect} delta) on
     *  resume — control edge here, never an injected prompt. Recurses up via the parent's own drain-exit. */
    async #onDrainExit(workspaceId: number, workerId: number, systemPrompt: string): Promise<void> {
        const slept = await this.#db.drain_find_slept_loop.get<{ id: number }>({ worker_id: workerId });
        if (slept !== undefined) return; // parked at 202 — not concluded, the worker is still alive
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        if (openSubs.length > 0) return; // a stream still runs — its conclusion re-evaluates, not this exit
        const parent = await this.#db.worker_parent_id.get<{ parent_worker_id: number | null }>({ worker_id: workerId });
        if (parent?.parent_worker_id == null) return; // a root worker — nobody to wake
        await this.#settleCompletionWake(workspaceId, parent.parent_worker_id, systemPrompt);
    }

    // {§methods-event-subscribe} — subscriber failures are transport-local:
    // log them at this boundary and never re-enter engine control flow.
    #emitTo(workspaceId: number | null, method: string, params?: unknown): void {
        for (const sub of this.#eventSubscribers) {
            try { sub(workspaceId, method, params); }
            catch (e) { console.error(`seam subscriber failed on ${method}:`, e instanceof Error ? e.message : String(e)); }
        }
    }

    #broadcast(target: NotifyTarget, method: string, params?: unknown): void {
        observedSync( // {§observability-boundary}
            "stream.broadcast",
            { method, ...(target === "all" ? {} : { "workspace.id": target.workspaceId }) },
            () => {
                if (target === "all") {
                    // {§notifications-envelope-carries-workspaceid}: global events carry workspaceId null.
                    this.#emitTo(null, method, params);
                    return;
                }
                // {§methods-event-subscribe}: publish to the in-process source; transport modules subscribe
                // here (plurnk-agui renders to AG-UI+). Each subscriber owns its own fan-out; core just emits.
                // Scope-stamping onto the notification envelope ({§notifications-envelope-carries-workspaceid})
                // is each subscriber's edge concern now — the seam hands (workspaceId, method, params) raw.
                this.#emitTo(target.workspaceId, method, params);
            },
        );
    }
}

// {§methods} — the curated seam handed to a plugin module at boot is the client-interface contract,
// not the daemon's guts. A module couples to this (or its own structural mirror) and nothing else; the
// non-seam surface (start/stop/#internals) is not part of the contract. Derived from Daemon so the two
// never drift.
export type CoreSeam = Pick<Daemon,
    | "subscribeToEvents"
    | "pendingProposals" | "resolveProposal"
    | "runLoop" | "cancelDrain" | "dispatchClientAction" | "ensureModelWorker"
    | "readLog" | "readEntry" | "look"
    | "listProviders" | "listWorkspaces" | "listWorkers" | "listPrompts" | "listMembers" | "listConstraints" | "workspaceDerivationStatus"
    | "listClientDisplayCapabilities"
    | "createWorkspace" | "attachWorkspace" | "createConversationWorker" | "renameWorkspace" | "constrain" | "unconstrain"
    | "forkWorker"
    | "listModuleActions" | "invokeModuleAction"
>;
