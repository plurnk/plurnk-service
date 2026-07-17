// Top-level daemon orchestrator. Owns the DB connection, engine, registries,
// the daughter-module seam (#364: the daemon owns no transport).
// SPEC §rpc.

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Db, PrepMethod } from "../core/Db.ts";
import type { ProposalResolution } from "../core/ProposalLifecycle.ts";
import ChannelWrite, { type WakeWorkerPayload } from "../core/ChannelWrite.ts";
import { Paths } from "../index.ts";
import Engine from "../core/Engine.ts";
import ExecutorRegistry from "../core/ExecutorRegistry.ts";
import SchemeRegistry from "../core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Provider } from "@plurnk/plurnk-providers";
// The event scope (#364 — relocated from the retired MethodRegistry): "all" = a global event
// (workspace/created), {workspaceId} = workspace-scoped. "this" retired with the per-connection leg.
export type NotifyTarget = "all" | { workspaceId: number };
// One drained loop's terminal shape — the drain's return currency.
export interface DrainLoopResult { loopId: number; finalStatus: number; hitMaxTurns: boolean; turnIds: number[]; action?: string; usage?: { promptTokens: number; completionTokens: number; costPico: number } }
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import LogEntry from "./logEntry.ts";
import type { LogEntryWire } from "./logEntry.ts";
import Envelope from "./envelope.ts";
import ClientInput from "./client-input.ts";
import type { ClientEnvelope } from "./envelope.ts";
import ClientTurn from "./clientTurn.ts";
import LoopDocs from "./loopDocs.ts";
import GitMembership from "../core/git-membership.ts";
import Fork from "../core/fork.ts";
import { promptLoopPrefix } from "../core/plurnk-uri.ts";
import { rulerCount } from "../core/token-ruler.ts";
import type { Executor, RegistryEntry } from "../core/ExecutorRegistry.ts";
import type { RuntimeDecl, RuntimeAvailability } from "@plurnk/plurnk-execs";
import { parseAliasesFromEnv, resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import { resolveLoopAlias } from "./loop-model.ts";
import Yolo from "./yolo.ts";
import NoProposals from "./noProposals.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { LoopFlags } from "../core/types.ts";


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
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #provider: Provider | null;
    #nodeModulesPath: string;
    #discoveryCwd: string;
    #started = false; // start() runs once — boots discovery + daughter modules (#364: no listener, ever)
    // The emit half of the broadcast, exposed as an in-process event source (#355). A transport
    // module (plurnk-agui) subscribes and fans out to its OWN clients; core emits, never fans out
    // for it. The WS fan-out below is legacy scaffolding that retires at the AG-UI+ cutover.
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
                const { action, loopId } = await this.inject({ workspaceId, workerId, prompt, provider: this.#provider, systemPrompt, ...(flags === undefined ? {} : { flags }) });
                return { action, loopId };
            },
            // worker:// KILL (terminate) — abort any worker's in-flight work by id. One
            // abort, one scope (Daemon.cancelDrain): the active loop closes 499,
            // background streams tear down. Whoever holds the address may end it.
            cancelWorker: (workerId) => this.cancelDrain(workerId, "killed via worker:// KILL"),
            telemetryEventNotify: (workspaceId, payload) => this.notifyTelemetryEvent(workspaceId, payload),
        });
        // Wire proposal-pending events to the loop/proposal WS notification.
        // Sessionid scopes the broadcast to clients on the same workspace.
        this.#engine.onProposalPending((event) => {
            this.#broadcast({ workspaceId: event.workspaceId }, "loop/proposal", {
                logEntryId: event.logEntryId,
                loopId: event.loopId,
                turnId: event.turnId,
                op: event.op,
                target: event.target,
                body: event.body,
                attrs: event.attrs,
                // event.flags is carried for discoverability — a client in
                // server-YOLO mode (event.flags.yolo=true) knows to skip
                // rendering review UI because the entry will resolve in-
                // process before any human can react.
                flags: event.flags,
            });
        });
        // In-tree YOLO listener — auto-accepts proposals when the loop's
        // persisted flags.yolo === true. Skips client roundtrip entirely.
        Yolo.attachYolo(this.#engine, this.#db);
        // Inverse of YOLO: auto-REJECT proposals in-process when the loop's
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
        return (this.#db.proposal_list_pending as PrepMethod).all<PendingProposal>({ workspace_id: workspaceId });
    }

    resolveProposal(logEntryId: number, resolution: ProposalResolution): void {
        this.#engine.resolveProposal(logEntryId, resolution);
    }

    // The client-interface seam (#355) — drive/steer a loop. The module supplies only workspace/run/prompt;
    // the provider and the law-file system prompt are core's and stay inside. Returns immediately — the
    // loop runs async and its outcome arrives on the event source (loop/terminated). `cancelDrain` (public)
    // is the cancel hook. Both funnel through the unified `inject`, which owns the drain lifecycle.
    async runLoop(args: { workspaceId: number; workerId: number; prompt: string; maxTurns?: number; flags?: Partial<LoopFlags>; openPaths?: string[]; alias?: string; model?: string }): Promise<{ action: "injected_next_turn" | "enqueued_new_loop"; loopId: number; turnSeq?: number }> {
        ClientInput.validateLoopFlags("loop.run", args.flags); // seam fail-hard (#364) — a truthy string must never flip YOLO
        // #414 — per-loop model selection: a client sends its alias/model on every loop, so a
        // switch takes effect turn-to-turn. `model` (client-resolved <provider>/<model>, #90) wins
        // over `alias`; neither → the boot default. Instantiation is cached, so ping-ponging
        // between two models is cheap, and an unresolvable alias/model fails loud here.
        const provider = await this.#resolveLoopProvider(args.alias, args.model);
        if (provider === null) throw new Error("runLoop: no provider configured");
        const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
        // §machine-processes — the model NEVER runs in a client-origin run (its packets would carry
        // client op.* rows). The module resolves the model worker via ensureModelWorker and passes it (or a
        // fork); a client worker here is a caller error, refused loudly rather than silently rehomed.
        const target = await (this.#db.envelope_get_worker_by_id as PrepMethod).get<{ workspace_id: number; origin: string }>({ id: args.workerId });
        if (target === undefined) throw new Error(`runLoop: run ${args.workerId} not found`);
        if (target.origin === "client") throw new Error(`runLoop: run ${args.workerId} is a client worker — loops run in model workers (§machine-processes); resolve one with ensureModelWorker(workspaceId)`);
        // Pre-loop docs (both sets: operator/client mdDocs + the teaching docs the turn-1
        // FIND(plurnk://docs/**) foist discovers) — ONE truth shared with the legacy loop.run route.
        await LoopDocs.materialize(this.#engine, this.#db, args.workspaceId);
        // §operator-config-max-turns-ceiling — the operator ceiling clamps a per-call maxTurns; a
        // seam caller must not bypass operator policy (inject only DEFAULTS from env, never clamps).
        const ceiling = Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "-1");
        const requested = args.maxTurns ?? ceiling;
        const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));
        const { action, loopId, turnSeq } = await this.inject({ ...args, ...(maxTurns >= 0 ? { maxTurns } : {}), provider, systemPrompt });
        return { action, loopId, ...(turnSeq !== undefined ? { turnSeq } : {}) };
    }

    // #414 — resolve a per-loop model override to a Provider (cached instances). `model`
    // (<provider>/<model>, client-resolved #90) wins over a named `alias`; absent both, the
    // boot default. A named alias missing from the env cascade, or a malformed model spec, throws
    // legibly rather than silently running the wrong model.
    async #resolveLoopProvider(alias: string | undefined, model: string | undefined): Promise<Provider | null> {
        const spec = resolveLoopAlias(alias, model, parseAliasesFromEnv());
        return spec === null ? this.#provider : ProviderInstantiate.instantiateProvider(spec);
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
        const turnId = await ClientTurn.insertClientTurn(this.#db, clientLoopId);
        const entryIds: number[] = [];
        const result = await this.#engine.dispatch({
            statement, workspaceId, workerId, loopId: clientLoopId, turnId, sequence: 1,
            origin: "client", onDispatch: (logEntryId: number) => { entryIds.push(logEntryId); },
        });
        for (const logEntryId of entryIds) {
            const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
            this.#broadcast({ workspaceId }, "log/entry", { entry });
        }
        return result as { status: number; [key: string]: unknown };
    }

    // op.look (#283/#358) — the pure READ-projection query on the seam: resolve a READ through the
    // full scheme resolver and return its content, writing NO log row — the client's off-run
    // inspection primitive (the module rewrites LOOK→READ and parses at its edge, exactly like
    // dispatchAsClient). Rides the client loop so log:/// coordinates resolve run-relative;
    // invisible to the model. Engine.look enforces READ-only.
    async look(args: { workspaceId: number; workerId: number; statement: PlurnkStatement }): Promise<{ status: number; [key: string]: unknown }> {
        const { workspaceId, workerId, statement } = args;
        const clientLoopId = await Envelope.ensureClientLoop(this.#db, workerId);
        return await this.#engine.look({ statement, workspaceId, workerId, loopId: clientLoopId }) as { status: number; [key: string]: unknown };
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
        const target = await (this.#db.envelope_get_worker_by_id as PrepMethod).get<{ workspace_id: number }>({ id: workerId });
        if (target === undefined) throw new Error(`run ${workerId} not found`);
        if (target.workspace_id !== workspaceId) throw new Error(`run ${workerId} is not in this workspace (${workspaceId})`);
        const rows = await (this.#db.log_read_recent_ids as PrepMethod).all<{ id: number }>({
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
                    // promptBudget = the EFFECTIVE prompt budget (window minus reserves, #345; named honestly #481) — the same
                    // denominator loop-usage reports; known for the active alias, null elsewhere.
                    promptBudget: isActive && this.#provider !== null ? this.#engine.promptBudgetFor(this.#provider) : null,
                };
            }),
        };
    }

    listWorkspaces() { return Envelope.listWorkspaces(this.#db); }
    listWorkers(workspaceId: number) { return Envelope.listWorkersForWorkspace(this.#db, workspaceId); }
    listPrompts(workspaceId: number, limit: number = 100) { return Envelope.listPromptsForWorkspace(this.#db, workspaceId, limit); }
    listMembers(workspaceId: number) { return GitMembership.resolveMembershipEffects(this.#db, workspaceId, undefined); }
    listConstraints(workspaceId: number) {
        return (this.#db.crud_list_workspace_constraints as PrepMethod).all<{ effect: string; glob: string }>({ workspace_id: workspaceId });
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
            await (this.#db.crud_insert_workspace_constraint as PrepMethod).run({ workspace_id: envelope.workspaceId, effect, glob });
        }
        if (constraints.length > 0) await GitMembership.resolveGitMembership(this.#db, envelope.workspaceId, undefined);
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
        const taken = await (this.#db.envelope_get_workspace_by_name as PrepMethod).get<{ id: number }>({ name });
        if (taken !== undefined && taken.id !== workspaceId) throw new Error(`a workspace named "${name}" already exists — pick another`);
        return { id: workspaceId, name: await Envelope.updateWorkspaceName(this.#db, workspaceId, name) };
    }

    async constrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        ClientInput.assertConstraint("workspace.constrain", effect, glob);
        // Headless is FOREVER (owner ruling, 2026-07-11, matching the client SPEC): a workspace is
        // born with its workspace pointer or never has one — so a 'repo' constraint on a headless
        // workspace can never resolve. Refuse legibly instead of recording a forever-pending lie.
        if (effect === "repo") {
            const s = await (this.#db.envelope_get_workspace as PrepMethod).get<{ project_root: string | null }>({ id: workspaceId });
            if (s?.project_root == null) throw new Error("workspace.constrain: this workspace is headless — and headless is forever (a workspace pointer is set at workspace.create or never). A 'repo' overlay needs a workspace created with projectRoot.");
        }
        await (this.#db.crud_insert_workspace_constraint as PrepMethod).run({ workspace_id: workspaceId, effect, glob });
        await GitMembership.resolveGitMembership(this.#db, workspaceId, undefined);
        // Members may have just landed — warm their derivations NOW (fire-and-forget, off the hot
        // path), exactly like createWorkspace does (dogfood catch: '/repo' embeddings waited for a
        // later turn's pump).
        void this.#engine.warmWorkspaceDerivations(workspaceId).catch(() => {});
        return { effect, glob };
    }

    async unconstrain(workspaceId: number, effect: string, glob: string): Promise<{ effect: string; glob: string }> {
        ClientInput.assertConstraint("workspace.unconstrain", effect, glob);
        await (this.#db.crud_delete_workspace_constraint as PrepMethod).run({ workspace_id: workspaceId, effect, glob });
        await GitMembership.resolveGitMembership(this.#db, workspaceId, undefined);
        return { effect, glob };
    }

    // The entry-shape hook (#355) — one entry's channels + tags + metadata at a path. With channel+offset,
    // returns just that channel's content sliced from the offset: the incremental streaming read (#192,
    // the delta leaves storage, not the whole channel). The module renders growing output by re-polling.
    async readEntry(args: { workspaceId: number; target: string; channel?: string; offset?: number }): Promise<{ status: number; entry: EntryShape | null }> {
        const m = args.target.match(/^([a-z][a-z0-9+.-]*):\/\/(.*)$/);
        if (m === null) throw new Error(`readEntry: target must be URL-shaped (scheme://pathname); got: ${args.target}`);
        if (args.offset !== undefined && args.channel === undefined) throw new Error("readEntry: offset requires channel (which channel to slice)");
        const scheme = m[1];
        const pathname = m[2].split("#")[0];
        const row = await (this.#db.entry_read_lookup as PrepMethod).get<{ id: number; scope: string; workspace_id: number; scheme: string; pathname: string }>({ workspace_id: args.workspaceId, scheme, pathname });
        if (row === undefined) return { status: 404, entry: null };
        let channelRows: ChannelRow[];
        if (args.channel === undefined) {
            channelRows = await (this.#db.entry_read_channels as PrepMethod).all<ChannelRow>({ entry_id: row.id });
        } else {
            const r = await (this.#db.entry_read_channel_slice as PrepMethod).get<ChannelRow>({ entry_id: row.id, channel: args.channel, offset: args.offset ?? 0 });
            channelRows = r === undefined ? [] : [r];
        }
        const channels: EntryShape["channels"] = {};
        for (const c of channelRows) channels[c.name] = { content: c.content, contentLength: c.contentLength, mimetype: c.mimetype, tokens: c.tokens, state: c.state };
        const tagRows = await (this.#db.crud_read_tags as PrepMethod).all<{ tag: string }>({ entry_id: row.id });
        return { status: 200, entry: { id: row.id, scope: row.scope, workspaceId: row.workspace_id, scheme: row.scheme, pathname: row.pathname, channels, tags: tagRows.map((t) => t.tag) } };
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
        const workspace = await (this.#db.envelope_get_workspace as PrepMethod).get<{ id: number }>({ id: workspaceId });
        if (workspace === undefined) throw new Error(`run.create: workspace ${workspaceId} not found`);
        if (name !== undefined) {
            if (Envelope.RESERVED_RUN_NAMES.has(name.toLowerCase())) throw new Error(`run.create: name "${name}" is reserved for a non-client actor`);
            const taken = await (this.#db.envelope_get_worker_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) throw new Error(`run.create: a worker named "${name}" already exists — worker names are immutable, pick another`);
        }
        const run = await Envelope.createModelWorker(this.#db, workspaceId, name);
        return { workerId: run.id, workerName: run.name };
    }

    // ownership check and the run-name namespace + uniqueness invariants (names are immutable — no rename).
    async forkWorker(args: { workspaceId: number; workerId: number; name?: string }): Promise<{ workerId: number; workerName: string | null; parentWorkerId: number }> {
        if (args.name !== undefined && (typeof args.name !== "string" || args.name.length === 0)) throw new Error("run.fork: name must be a non-empty string"); // seam fail-hard (#364)
        const { workspaceId, workerId, name } = args;
        const owner = await (this.#db.envelope_get_worker_by_id as PrepMethod).get<{ workspace_id: number }>({ id: workerId });
        if (owner === undefined) throw new Error(`forkWorker: run ${workerId} not found`);
        if (owner.workspace_id !== workspaceId) throw new Error(`forkWorker: run ${workerId} is not in workspace ${workspaceId}`);
        if (name !== undefined) {
            if (Envelope.RESERVED_RUN_NAMES.has(name.toLowerCase())) throw new Error(`forkWorker: name "${name}" is reserved for a non-client actor`);
            const taken = await (this.#db.envelope_get_worker_by_name as PrepMethod).get<{ id: number }>({ workspace_id: workspaceId, name });
            if (taken !== undefined) throw new Error(`forkWorker: a worker named "${name}" already exists — worker names are immutable, pick another`);
        }
        const branchWorkerId = await Fork.fork(this.#db, workerId, name);
        const branch = await (this.#db.envelope_get_worker_by_id as PrepMethod).get<{ name: string }>({ id: branchWorkerId });
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

    // The boot plug-point (#355 hook D) — register a daughter module before start(); its init runs at
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

        // #364 — the daemon opens NO transport, ever: daughter modules open theirs via the seam.
        for (const init of this.#moduleInits) await init(this);
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
        for (const scope of this.#workerAborts.values()) { if (!scope.signal.aborted) scope.abort("daemon_stopping"); }
        for (const t of this.#pollTimers.values()) clearTimeout(t); // drop pending hibernation poll-wakes
        this.#pollTimers.clear();
        // …and the park-DEADLINE timers (#432): a bounded park's timer fires #wakeParkedWorker after
        // stop/db-close if left pending — an unhandled rejection (SqlRite closed) that abnormally
        // exits the worker under load. Symmetric with the poll-wakes above; both must be reaped.
        for (const t of this.#parkTimers.values()) clearTimeout(t);
        this.#parkTimers.clear();
        const drainPromises = [...this.#activeDrains.values()].map((d) => d.promise);
        await Promise.allSettled(drainPromises);
        await this.#drainStreamingSchemes();
        await this.#engine.drainDerivations(); // §derivation-off-hot-path — background pumps finish before the db closes upstream
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
     * Emit a telemetry/event notification scoped to the workspace containing
     * the loop. TelemetryChannel.push invokes this for every TelemetryEvent
     * (parse_error, strike, cycle, sudden_death, no_ops, max_commands_exceeded,
     * action_failure) the moment it lands in the loop's telemetry buffer.
     * SPEC §telemetry.
     */
    notifyTelemetryEvent(workspaceId: number, payload: { loopId: number; event: object }): void {
        this.#broadcast({ workspaceId }, "telemetry/event", payload);
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
            ? await (this.#db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: loopId })
            : await (this.#db.drain_active_loop_flags as PrepMethod).get<{ id: number; flags: string }>({ worker_id: workerId });
        const effective: Record<string, unknown> = { ...DEFAULT_LOOP_FLAGS, ...JSON.parse(row?.flags ?? "{}") as object };
        const conflicts = Object.entries(flags).filter(([k, v]) => v !== undefined && effective[k] !== v).map(([k, v]) => `${k}: ${JSON.stringify(effective[k])} → ${JSON.stringify(v)}`);
        if (conflicts.length > 0) {
            throw new Error(`inject: the prompt would fold into a live loop whose flags differ (${conflicts.join(", ")}) — flags are loop-scoped and never change mid-flight. Cancel the loop (loop.cancel) and re-run with the new flags, or send the prompt without flags to adopt the loop's posture.`);
        }
    }

    async inject(args: {
        workspaceId: number; workerId: number; prompt: string;
        provider: Provider; systemPrompt: string;
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
            const slept = await (this.#db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ worker_id: workerId });
            if (slept !== undefined) {
                await this.#assertFoldPosture(workerId, args.flags, slept.id); // #368 — the resume path drops nothing silently either
                const injected = await this.#engine.inject(workerId, prompt);
                await (this.#db.drain_resume_slept_loop as PrepMethod).run({ loop_id: slept.id });
                const started = await this.#ensureDrain({
                    workspaceId, workerId, provider: args.provider, systemPrompt: args.systemPrompt,
                    maxTurns: args.maxTurns ?? Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
                });
                return { action: "injected_next_turn", loopId: slept.id, ...(injected?.turnSeq !== undefined ? { turnSeq: injected.turnSeq } : {}), ...(started ?? {}) };
            }
        }

        // Enqueue a fresh loop. Persist flags on the row.
        const seqRow = await (this.#db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ worker_id: workerId });
        if (seqRow === undefined) throw new Error("inject: next-sequence query returned no row");
        const loopRow = await (this.#db.drain_enqueue_loop as PrepMethod).get<{ id: number }>({
            worker_id: workerId, sequence: seqRow.next, prompt,
        });
        if (loopRow === undefined) throw new Error("inject: loop enqueue returned no row");
        const loopId = loopRow.id;

        if (args.flags !== undefined) {
            const merged = { ...DEFAULT_LOOP_FLAGS, ...args.flags };
            await (this.#db.engine_set_loop_flags as PrepMethod).run({
                loop_id: loopId, flags: JSON.stringify(merged),
            });
        }
        // #260 — persist client-passed @file paths before the drain claims the loop, so turn 0 foists them.
        if (args.openPaths !== undefined && args.openPaths.length > 0) {
            await (this.#db.engine_set_loop_open_paths as PrepMethod).run({
                loop_id: loopId, open_paths: JSON.stringify(args.openPaths),
            });
        }

        // Guarantee a drain claims the loop we just enqueued. #ensureDrain runs its
        // check-and-start UNDER the per-worker drain lock (§worker-lifecycle-single-drain),
        // serialized against a draining sibling's teardown relinquish so the two can't
        // both register a drain (R4). A live drain re-claims the loop in its own
        // iteration or its lock-held exit re-claim, so it's never stranded.
        // firstLoopPromise is present only when THIS call started the drain — loop.run
        // keys its fast-path response on that.
        const started = await this.#ensureDrain({
            workspaceId, workerId, provider: args.provider,
            systemPrompt: args.systemPrompt,
            maxTurns: args.maxTurns ?? Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
        });
        return { action: "enqueued_new_loop", loopId, ...(started ?? {}) };
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
        workspaceId: number; workerId: number; provider: Provider;
        systemPrompt: string; maxTurns: number;
    }): {
        firstLoopPromise: Promise<DrainLoopResult>;
        drainPromise: Promise<{ loopsDrained: number; lastResult: DrainLoopResult | null }>;
    } {
        const { workspaceId, workerId, provider, systemPrompt, maxTurns } = opts;
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

        const claim = () => (this.#db.drain_claim_next_loop as PrepMethod).get<{
            id: number; sequence: number; prompt: string;
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
                    const onDispatch = (logEntryId: number): void => {
                        // #506 — a rejection here was a silent process-death vector (unhandled in a
                        // fire-and-forget void); a log-broadcast failure must never crash the drain.
                        void (async () => {
                            const entry = await LogEntry.fetchLogEntry(this.#db, logEntryId);
                            this.#broadcast({ workspaceId }, "log/entry", { entry });
                        })().catch((e: unknown) => console.error("log/entry broadcast failed:", e instanceof Error ? e.message : String(e)));
                    };
                    const result = await this.#engine.runLoop({
                        provider, workspaceId, workerId, loopId: loopRow.id, maxTurns,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: loopRow.prompt },
                        ],
                        origin: "model",
                        onDispatch,
                        signal: controller.signal,
                    });
                    if (result.finalStatus === 202) {
                        // The loop SLEPT (parked via [102]<T>/<-1>) — suspended, not terminated. Leave it at 202
                        // (resumable); no loop/terminated, no orphan-reconcile. A stream conclusion
                        // (#handleWakeWorker) re-queues it; and if it holds a polled stream, a poll timer
                        // wakes it every P to inspect (§exec-poll). §worker-lifecycle-wake-liveness.
                        void this.#schedulePollWake(workspaceId, workerId, provider, systemPrompt).catch((err: unknown) => console.error("poll-wake scheduling failed:", err instanceof Error ? err.message : String(err)));
                        // §send-premature-terminate/[102]<T> — the park DEADLINE (grammar 0.75.0): the
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
                                    void this.#wakeParkedWorker(workspaceId, workerId, provider, systemPrompt).catch((err: unknown) => console.error("park-deadline wake failed:", err instanceof Error ? err.message : String(err)));
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
                            await (this.#db.drain_resume_slept_loop as PrepMethod).run({ loop_id: loopRow.id });
                            continue;
                        }
                        // The loop is blocked at 202 on a live obligation (§wait-obligation-matrix);
                        // that obligation's conclusion is its wake edge (the owed-wake above covers the
                        // conclude-before-block race). An idle wait never reaches here — it concluded at dispatch.
                        continue;
                    }
                    this.#owedWakes.delete(workerId); // the loop concluded (non-202) — no park to honor a held wake at
                    const usage = await this.#engine.loopUsage(loopRow.id);
                    this.#broadcast({ workspaceId }, "loop/terminated", {
                        loopId: loopRow.id,
                        finalStatus: result.finalStatus,
                        hitMaxTurns: result.hitMaxTurns,
                        turnIds: result.turnIds,
                        usage,
                    });
                    loopsDrained++;
                    const loopResult: DrainLoopResult = {
                        loopId: loopRow.id,
                        turnIds: result.turnIds,
                        finalStatus: result.finalStatus,
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
                }
            } catch (err) {
                if (controller.signal.aborted) {
                    // #204 / Model 3 — loop.cancel / shutdown aborted the live drain. A cancellation
                    // is the loop's TERMINAL state (499), delivered via loop/terminated (loop.run no
                    // longer blocks to return it). A genuine error rejects firstLoopPromise.
                    const usage = currentLoopId === null
                        ? { promptTokens: 0, completionTokens: 0, costPico: 0, contextTokens: 0, promptBudget: null, meta: {} }
                        : await this.#engine.loopUsage(currentLoopId);
                    if (currentLoopId !== null) {
                        // #380 (owner ruling) — the cancel is allowed but provenanced: the ROW goes
                        // terminal 499 (a dead loop must never read as live 102, #311) carrying
                        // terminated_by='cancel' + the abort reason as the abandonment message, and
                        // the broadcast carries the same message. The abort reason is the client's
                        // loop.cancel reason (cancelDrain threads it through scope.abort).
                        const message = String(controller.signal.reason ?? "user_cancelled").slice(0, 500);
                        await (this.#db.engine_loop_cancel_external as PrepMethod).run({ loop_id: currentLoopId, message });
                        this.#broadcast({ workspaceId }, "loop/terminated", {
                            loopId: currentLoopId, finalStatus: 499, hitMaxTurns: false, turnIds: [], usage, message,
                        });
                    }
                    if (!firstSettled) {
                        firstSettled = true;
                        resolveFirst({ loopId: currentLoopId ?? 0, turnIds: [], finalStatus: 499, hitMaxTurns: false, usage });
                    }
                } else {
                    // #265 — a genuine (non-abort) loop error must still reach the client. loop.run only
                    // acked finalStatus:100, so loop/terminated is the sole outcome channel; the rejection
                    // alone reaches no one (firstLoopPromise/drainPromise are .catch()'d). Broadcast 500
                    // (failed) — distinct from an abort's 499 — for every error, not just the pre-first one.
                    // #506 — the WHY must reach every forensic channel, not one. The old handler
                    // fed only the loop row + broadcast; run54 died with the daemon log silent, zero
                    // error telemetry, and a bare 500 — the cause (a stack) reachable nowhere. The
                    // daemon-log line + the error telemetry event fire even when currentLoopId is null
                    // or the row-write itself is what failed, so a death is never traceless again.
                    console.error(`drain error (workspace ${workspaceId}, worker ${workerId}, loop ${currentLoopId ?? "?"}):`, err);
                    if (currentLoopId !== null) {
                        this.notifyTelemetryEvent(workspaceId, { loopId: currentLoopId, event: { source: "daemon:drain", kind: "loop_error", level: "error", message: err instanceof Error ? err.message : String(err) } });
                        // #311 — the failure must be first-class on BOTH surfaces: the loop row goes
                        // terminal 500 carrying the cause (a dead loop must never read as live 102 —
                        // the premature-terminate gate counts live loops), and the broadcast carries
                        // the same message so a backend 400 (context overflow, auth, …) reaches the
                        // client as text, never a contentless 500.
                        const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
                        await (this.#db.engine_loop_set_status as PrepMethod).run({ loop_id: currentLoopId, status: 500, message });
                        const usage = await this.#engine.loopUsage(currentLoopId);
                        this.#broadcast({ workspaceId }, "loop/terminated", {
                            loopId: currentLoopId, finalStatus: 500, hitMaxTurns: false, turnIds: [], usage, message,
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
        drainPromise.then(() => this.#onDrainExit(workspaceId, workerId, provider, systemPrompt)).catch(() => {});
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
        workspaceId: number; workerId: number; provider: Provider;
        systemPrompt: string; maxTurns: number;
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
        const endedSeq = (await (this.#db.engine_loop_sequence as PrepMethod).get<{ sequence: number }>({ loop_id: endedLoopId }))?.sequence ?? endedLoopId;
        const prefix = promptLoopPrefix(workerId, endedSeq);
        const orphan = await (this.#db.drain_orphaned_prompt_for_loop as PrepMethod).get<{
            body: string; flags: string | null;
        }>({ loop_id: endedLoopId, pattern: `${prefix}%`, prefix_len: prefix.length });
        if (orphan === undefined) return;
        const seqRow = await (this.#db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ worker_id: workerId });
        if (seqRow === undefined) throw new Error("reconcileOrphanedWake: next-sequence query returned no row");
        const fresh = await (this.#db.drain_enqueue_loop as PrepMethod).get<{ id: number }>({
            worker_id: workerId, sequence: seqRow.next, prompt: orphan.body,
        });
        if (fresh === undefined) throw new Error("reconcileOrphanedWake: enqueue returned no row");
        if (orphan.flags !== null) {
            await (this.#db.engine_set_loop_flags as PrepMethod).run({ loop_id: fresh.id, flags: orphan.flags });
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
        const scope = this.#workerAborts.get(workerId);
        if (scope !== undefined && !scope.signal.aborted) scope.abort(reason);
        // #380, the PARKED case — a 202-blocked loop has no drain to observe the abort (the
        // drain tears down on 202), so before this a cancelled park stayed 202 forever with no
        // terminal and no broadcast. Terminalize the worker's live loops (102/202; queued 100 stays
        // enqueued) with provenance and broadcast each. With a live drain its abort catch does
        // this instead — skipping here keeps the broadcast single.
        if (!hadDrain) {
            void (async () => {
                const message = reason.slice(0, 500);
                const dead = await (this.#db.engine_worker_cancel_live_loops as PrepMethod).all<{ id: number }>({ worker_id: workerId, message });
                if (dead.length === 0) return;
                const srow = await (this.#db.drain_get_worker_workspace as PrepMethod).get<{ workspace_id: number }>({ worker_id: workerId });
                if (srow === undefined) return;
                for (const { id } of dead) {
                    const usage = await this.#engine.loopUsage(id);
                    this.#broadcast({ workspaceId: srow.workspace_id }, "loop/terminated", {
                        loopId: id, finalStatus: 499, hitMaxTurns: false, turnIds: [], usage, message,
                    });
                }
            })().catch((err: unknown) => {
                console.error(`cancelDrain(${workerId}) live-loop terminalize failed:`, err);
            });
        }
        // Total reap by the REGISTRY (§worker-lifecycle-total-reap): the durable source
        // of truth. Every open subscription the worker holds, aborted via its owning
        // scheme — independent of the signal-listener timing, so an exec mid-spawn
        // (registry row written before it is killable) is reaped too. A late spawn
        // (registering after this) self-aborts against its captured, now-aborted
        // epoch (§exec-timeout). Idempotent; fire-and-forget (the
        // abort is sync, the registry read async; the 499 conclusion surfaces async).
        void this.#reapWorkerStreams(workerId).catch((err: unknown) => {
            console.error(`reapWorkerStreams(${workerId}) failed:`, err);
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

    // The registry-routed reap (§worker-lifecycle-total-reap): every open subscription
    // the worker holds, aborted via its owning scheme. The durable answer to "reap
    // everything" — the in-process AbortSignal listener is the optimization, this is
    // the source of truth: an exec mid-spawn (registry row written before it is
    // killable) or a background exec from any past loop is caught regardless of
    // listener timing. Idempotent — a stream the signal already reaped is a no-op.
    async #reapWorkerStreams(workerId: number): Promise<void> {
        const open = await ChannelWrite.findOpenSubscriptionsForWorker(this.#db, workerId);
        for (const { id, scheme } of open) {
            const handler = this.#schemes.get(scheme) as { abortSubscription?: (subscriptionId: number) => void } | undefined;
            handler?.abortSubscription?.(id);
        }
    }

    /**
     * Wake-on-completion handler. Streaming schemes call this when a
     * subscription closes. If the worker has an active loop, the channel
     * transition will surface at that loop's next turn boundary — no new
     * loop needed. Otherwise we open a fresh loop with the synthetic
     * summary as the user prompt so the model gets a chance to react.
     *
     * Skipped on closeStatus=499 (aborted): the model already knows about
     * its own SEND[499], and a forcefully-cancelled loop's spawn-abort
     * shouldn't resurrect into a wake loop (defeats the cancel).
     *
     * Rummy parallel: plugins/stream/stream.js stream/completed wake:true.
     */
    async #handleWakeWorker(payload: WakeWorkerPayload): Promise<void> {
        // §search-gate — settle the dedup registration: promote on a 200 conclusion, drop on
        // failure (a dead search must never serve as a duplicate). No-op for non-search streams.
        this.#engine.searchGate.settle(payload.target.replace(/^[a-z+.-]+:\/\//, "/").replace(/^\/+/, "/"), payload.closeStatus);
        // Aborted streams don't wake — the abort was deliberate.
        if (payload.closeStatus === 499) {
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

        if (this.#provider === null) {
            this.#broadcast({ workspaceId: payload.workspaceId }, "stream/concluded", {
                ...payload, wakeAction: "skipped-no-provider",
            });
            return;
        }

        try {
            const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");

            // A slept (202) loop means the worker PARKED ([102]<T>/<-1>) → RESUME it IN PLACE: re-queue
            // it (202→100) so the drain re-claims and CONTINUES it (seq>1 → no re-foist). Checked
            // FIRST: the slept status is the worker's true disposition regardless of a draining
            // sibling mid-teardown (the #ensureDrain lock serializes the re-claim). No fresh loop,
            // no summary-as-prompt — the resumed loop reads the concluded stream's own state from
            // the manifest. §worker-lifecycle-wake-liveness.
            const slept = await (this.#db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ worker_id: payload.workerId });
            if (slept !== undefined) {
                await (this.#db.drain_resume_slept_loop as PrepMethod).run({ loop_id: slept.id });
                const started = await this.#ensureDrain({
                    workspaceId: payload.workspaceId, workerId: payload.workerId, provider: this.#provider,
                    systemPrompt, maxTurns: Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
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
    async #schedulePollWake(workspaceId: number, workerId: number, provider: Provider, systemPrompt: string): Promise<void> {
        const existing = this.#pollTimers.get(workerId);
        if (existing !== undefined) { clearTimeout(existing); this.#pollTimers.delete(workerId); }
        const row = await (this.#db.drain_worker_min_poll as PrepMethod).get<{ poll_seconds: number | null }>({ worker_id: workerId });
        const pollSec = row?.poll_seconds ?? null;
        if (pollSec === null || pollSec <= 0) return; // no polled stream → the 202 just sleeps (woken only by conclusion)
        // Floored by the post-EXEC breath (PLURNK_SERVICE_EXEC_WAIT_MS) so a `<…,1>` can't wake the loop
        // faster than a turn settles — §exec-poll.
        const execWaitMs = Number(process.env.PLURNK_SERVICE_EXEC_WAIT_MS ?? "0");
        const timer = setTimeout(() => {
            this.#pollTimers.delete(workerId);
            void this.#wakeParkedWorker(workspaceId, workerId, provider, systemPrompt);
        }, Math.max(pollSec * 1000, execWaitMs));
        timer.unref();
        this.#pollTimers.set(workerId, timer);
    }

    /** Resume `workerId`'s slept (202) loop in place — the same 202→100 resume #handleWakeWorker uses, minus a
     *  wake payload. The shared wake primitive: a poll cadence (§exec-poll), a watched stream concluding,
     *  or a child worker finishing (§run-lifecycle topology join) all call this. A no-op if the worker was
     *  cancelled or isn't actually parked (no slept loop) — so calling it speculatively is safe. */
    async #wakeParkedWorker(workspaceId: number, workerId: number, provider: Provider, systemPrompt: string): Promise<void> {
        const scope = this.#workerAborts.get(workerId);
        if (scope?.signal.aborted === true && !this.#activeDrains.has(workerId)) return; // cancelled — no resurrection
        const slept = await (this.#db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ worker_id: workerId });
        if (slept === undefined) {
            // Not parked. If a drain is still ACTIVE, the worker is mid-turn and about to park — the
            // conclusion that fired this wake arrived before the 202 committed (the conclude-before-park
            // race). OWE the wake: the drain honors it at park so a worker-run hibernation never deadlocks.
            // (No active drain → already concluded/running; nothing to wake.)
            if (this.#activeDrains.has(workerId)) this.#owedWakes.add(workerId);
            return;
        }
        await (this.#db.drain_resume_slept_loop as PrepMethod).run({ loop_id: slept.id });
        const started = await this.#ensureDrain({
            workspaceId, workerId, provider, systemPrompt,
            maxTurns: Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "50"),
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
    async #onDrainExit(workspaceId: number, workerId: number, provider: Provider, systemPrompt: string): Promise<void> {
        const slept = await (this.#db.drain_find_slept_loop as PrepMethod).get<{ id: number }>({ worker_id: workerId });
        if (slept !== undefined) return; // parked at 202 — not concluded, the worker is still alive
        const openSubs = await (this.#db.find_open_subscriptions_for_worker as PrepMethod).all<{ id: number }>({ worker_id: workerId });
        if (openSubs.length > 0) return; // a stream still runs — its conclusion re-evaluates, not this exit
        const parent = await (this.#db.worker_parent_id as PrepMethod).get<{ parent_worker_id: number | null }>({ worker_id: workerId });
        if (parent?.parent_worker_id == null) return; // a root run — nobody to wake
        await this.#wakeParkedWorker(workspaceId, parent.parent_worker_id, provider, systemPrompt);
    }

    #broadcast(target: NotifyTarget, method: string, params?: unknown): void {
        if (target === "all") {
            // A global engine event (e.g. workspace/created) — emitted to the seam with workspaceId null (#355).
            for (const sub of this.#eventSubscribers) sub(null, method, params);
            return;
        }
        const workspaceId = target.workspaceId;
        // Publish the raw event to the in-process source first (#355) — transport modules subscribe
        // here (plurnk-agui renders to AG-UI+). Each subscriber owns its own fan-out; core just emits.
        for (const sub of this.#eventSubscribers) sub(workspaceId, method, params);
        // Scope-stamping onto the notification envelope (§notifications-envelope-carries-workspaceid)
        // is each subscriber's edge concern now — the seam hands (workspaceId, method, params) raw.
    }
}

// The curated seam handed to a daughter module at boot (#355 hook D) — the client-interface contract,
// not the daemon's guts. A module couples to this (or its own structural mirror) and nothing else; the
// non-seam surface (start/stop/#internals) is not part of the contract. Derived from Daemon so the two
// never drift.
export type CoreSeam = Pick<Daemon,
    | "subscribeToEvents"
    | "pendingProposals" | "resolveProposal"
    | "runLoop" | "cancelDrain" | "dispatchAsClient" | "ensureModelWorker"
    | "readLog" | "readEntry" | "look"
    | "listProviders" | "listWorkspaces" | "listWorkers" | "listPrompts" | "listMembers" | "listConstraints"
    | "createWorkspace" | "attachWorkspace" | "createConversationWorker" | "renameWorkspace" | "constrain" | "unconstrain"
    | "forkWorker"
    | "hotloadRuntime"
>;
