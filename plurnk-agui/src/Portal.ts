// {§agui-daemon-client} The in-process module's orchestration engine composes the seam +
// the render router + the HITL core into the worker flow: subscribe ONCE to the event
// source, route each event to the Run that owns its worker/loop, drive/cancel loops via
// the seam, and route standard resume entries to resolveProposal. Transport-agnostic —
// the HTTP/SSE listener (the outward edge) and workspace establishment (workspace-lifecycle
// hook, pending) wrap this; the engine is testable against a mock seam today.

import EventRouter from "./EventRouter.ts";
import { aliveChildren, spendState, stateDelta, type AguiStatusState } from "./AguiPlus.ts";
import { Problems, Validator, selectWorkerLoop } from "@plurnk/plurnk-contracts";
import { HttpProblemError } from "./action-results.ts";
import { runErrorEvents, serviceStoppingProblem } from "./run-events.ts";
import Translator, { type TranslatorContinuation } from "./Translator.ts";
import ProposalHitl, { type HitlBatch, type HitlDelivery } from "./ProposalHitl.ts";
import type {
    ApplicationLoopProjection,
    ApplicationWorkerProjection,
    OperationResult,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { EventType, type AguiEvent, type LogEntryNotification, type TerminatedNotification, type UserMessage } from "./types.ts";
import type { Interrupt, ResumeEntry } from "@ag-ui/core";

interface Thread {
    workspaceId: number;
    owner: string | null;
    // {§agui-oauth-revocation} — the credential family this Run was admitted under; null when none was.
    family: string | null;
    // The Worker this Run observes: the bound worker, or an operation Run's runtime worker once its dispatch opens
    // its Loop; null while it has none.
    workerId: number | null;
    loopId: number | null;
    readonly notificationScope: NotificationScope;
    // {§agui-action-binding} The model worker this Run binds and reports the gauge of; null when it binds none.
    modelWorkerId: number | null;
    router: EventRouter;
    emit: (events: AguiEvent[]) => void;
    threadId: string;
    inputRunId: string;
    openStreams: Set<string>;   // stream addresses this Run owns until their stream/concluded
    // {§agui-broadcast-fan} An operation Run's Worker stream activity no row of its Loop has announced yet: per
    // address, the latest snapshot and the conclusion, delivered after the row that announces it.
    unannounced: Map<string, { event: unknown; concluded: unknown }>;
    deferredFinish: { readonly events: AguiEvent[]; readonly result: unknown } | null;
    pendingTerminations: unknown[];
    resolvingInterrupts: boolean;
    cancelOnDisconnect: boolean;
    disconnected: boolean;
    // {§agui-gate-deferral} — the stopped-world held while the bound Worker's reasoning lifecycle is open.
    deferredDelivery: HitlDelivery | null;
    // {§agui-delegation-observation} — descendants' rows and streams, when the Run asked for them.
    descendants: boolean;
    tree: ReadonlyMap<number, Descendant> | null;
    introduced: Set<number>;
    unrelated: Set<number>;
    // {§agui-subagents} Each descendant loop this Run has judged, once: its subagent when a call in view opened it, else
    // null; and the subagents among them by loop id, in the order they were judged.
    judged: Map<number, Promise<Subagent | null>>;
    subagents: Map<number, Subagent>;
    // {§agui-status-children} {§agui-status-spend} — what this Run's client holds: its snapshot's, its
    // latest whole-gauge replacement's, then each delta's; null until the snapshot is presented.
    gauge: Pick<AguiStatusState, "children" | "spend"> | null;
    // A refresh was asked for before the snapshot was presented; it runs once the snapshot is.
    staleGauge: boolean;
    // The latest refresh begun: an earlier one that completes after it publishes nothing.
    gaugeRefresh: number;
}

export type NotificationScope = "worker" | "operation" | "result";

interface WorkerBinding {
    readonly workerId: number;
    readonly loopId: number;
}

// {§agui-subagents} A descendant loop a call in view opened: its subagent run, its worker, the call that opened it and
// the translator of its own conversation; its loop's conclusion once this Run knows it, and where this Run's stream
// stands with its segment.
export interface Subagent {
    readonly runId: string;
    readonly loopId: number;
    readonly workerId: number;
    readonly worker: string;
    // {§agui-delegation-observation} Its worker as the daemon's topology names it, which its start introduces.
    readonly descendant: Descendant;
    readonly loopSequence: number;
    readonly parent: { readonly call: string; readonly subagent?: Subagent };
    readonly translator: Translator;
    result: OperationResult | null;
    segment: "unstarted" | "open" | "ended";
}

// {§agui-snapshot} {§agui-subagents} The subagent runs a snapshot replays, parents first, each with its loop's rows.
export type SubagentHistory = ReadonlyArray<{ readonly subagent: Subagent; readonly entries: Array<Record<string, unknown>> }>;

// {§agui-delegation-observation} — a descendant as the daemon's topology names it, depth counted
// from the bound Worker.
export interface Descendant {
    readonly workerId: number;
    readonly name: string;
    readonly parentWorkerId: number;
    readonly depth: number;
}

interface InterruptContinuation {
    readonly cancelOnDisconnect: boolean;
    readonly workspaceId: number;
    readonly gate: WorkerBinding;
    readonly binding: { readonly workerId: number | null; readonly loopId: number | null };
    readonly modelWorkerId: number | null;
    readonly owner: string;
    readonly threadId: string;
    readonly state: TranslatorContinuation;
}

interface PresentedInterrupt {
    readonly toolCallId: string;
    readonly continuation: InterruptContinuation;
}

// The engine needs only the AG-UI Run-flow slice of the seam (workspace lifecycle and reads
// belong to the Module edge above it) — declare exactly that.
export type PortalPort = Pick<
    ApplicationPort,
    | "subscribeToEvents"
    | "pendingProposals"
    | "resolveProposal"
    | "pendingClientInteractions"
    | "resolveClientInteraction"
    | "listWorkers"
    | "listWorkerLoops"
    | "workerAccounting"
    | "runLoop"
    | "cancelDrain"
    | "cancelLoop"
>;

export default class Portal {
    #seam: PortalPort;
    // A workspace may have several simultaneous AG-UI Runs. The worker/loop carried by
    // each notification selects its owner; a Run is not a second broadcast subscription.
    #threads = new Map<number, Set<Thread>>();
    #hitl: ProposalHitl;
    #activeInterrupts = new Map<string, Interrupt>();
    #continuations = new Map<string, PresentedInterrupt>();
    #deliveryTails = new Map<number, Promise<void>>();
    // {§agui-subagents} The loops whose terminal the daemon has published and the Runs have yet to receive, in order.
    #terminalsDue = new Set<number>();
    #off: (() => void) | null = null;
    #stopped = false;

    constructor(seam: PortalPort) {
        this.#seam = seam;
        this.#hitl = new ProposalHitl(
            seam,
            (workspaceId, delivery) => this.#routeHitl(workspaceId, delivery),
        );
    }

    // One subscription for the whole module: render each event only to its owning Run.
    start(): void {
        this.#hitl.start();
        this.#off = this.#seam.subscribeToEvents((workspaceId, method, params) => {
            if (workspaceId === null) return; // global (workspace/created) handled out-of-band
            if (method === "loop/terminated") this.#terminalsDue.add((params as TerminatedNotification).loopId);
            // {§agui-proposal-resolve} {§agui-subagents} A workspace's events reach its Runs in the order the daemon
            // published them: while a descendant's topology or loop is being read, every later event waits for it.
            if (this.#deliveryTails.has(workspaceId)) {
                this.#enqueueDelivery(workspaceId, async () => this.#routeNotification(workspaceId, method, params));
                return;
            }
            const observing = this.#routeNotification(workspaceId, method, params);
            if (observing !== undefined) this.#enqueueDelivery(workspaceId, async () => observing);
        });
    }

    // Returns the descendants' events still being read for some Run's presentation, when there are any.
    #routeNotification(workspaceId: number, method: string, params: unknown): Promise<void> | undefined {
        if (method === "loop/terminated") this.#terminalsDue.delete((params as TerminatedNotification).loopId);
        const observing: Array<Promise<void>> = [];
        for (const thread of this.#threads.get(workspaceId) ?? []) {
            if (Portal.#touchesStatus(thread, method, params)) void this.#refreshStatus(thread);
            const actor = thread.descendants ? Portal.#observedActor(thread, method, params) : null;
            if (actor !== null) {
                observing.push(this.#observeDescendant(workspaceId, thread, actor, method, params));
                continue;
            }
            if (thread.descendants && method === "loop/terminated") {
                const concluded = Portal.#concluded(thread, params as TerminatedNotification);
                if (concluded !== null) {
                    if (concluded.length > 0) thread.emit(concluded);
                    continue;
                }
            }
            if (!Portal.#ownsNotification(thread, method, params)) {
                Portal.#holdUnannounced(thread, method, params);
                continue;
            }
            if (method === "loop/packet" && thread.loopId === null) {
                const loopId = (params as { loopId?: unknown }).loopId;
                if (typeof loopId === "number") thread.loopId = loopId;
            }
            if (method === "loop/terminated") {
                const loopId = (params as { loopId?: unknown }).loopId;
                if (typeof loopId !== "number") continue;
                if (thread.loopId === null || thread.resolvingInterrupts) {
                    thread.pendingTerminations.push(params);
                    continue;
                }
                if (thread.loopId !== loopId) continue;
            }
            // {§agui-broadcast-fan} — the row that announces an execution owns its stream for this Run
            // before any channel write: a stream/event is a race the action result must not win.
            const opened = Portal.#openedStream(method, params);
            if (opened !== null) thread.openStreams.add(opened);
            if (method === "stream/concluded") thread.openStreams.delete(Portal.#streamTarget(params));
            const out = Portal.#finishing(thread, thread.router.route(method, params));
            if (out.length > 0) thread.emit(out);
            if (method === "log/entry" && opened !== null) this.#releaseUnannounced(thread, opened);
            // {§agui-gate-deferral} — a terminal leaves the held gate durable for the next Run; any other
            // event that closed the reasoning lifecycle presents it now.
            if (method === "loop/terminated") thread.deferredDelivery = null;
            else this.#presentDeferred(workspaceId, thread);
            if (thread.openStreams.size === 0 && thread.deferredFinish !== null) {
                const deferred = thread.deferredFinish;
                thread.deferredFinish = null;
                this.#finishThread(thread, deferred.events, deferred.result);
            }
        }
        return observing.length === 0 ? undefined : Promise.all(observing).then(() => undefined);
    }

    // {§agui-status-children} {§agui-status-spend} — the events after which the bound Worker's alive
    // direct children or its spend may differ: another worker's loop concluded or began (it may be a
    // child), a turn settled its spend (its own or another worker's), or the bound Worker's own
    // WORK/FORK/KILL row landed (it spawned or killed one). The daemon is asked, never inferred.
    static #touchesStatus(thread: Thread, method: string, params: unknown): boolean {
        if (thread.notificationScope !== "worker") return false;
        const payload = params as { workerId?: unknown; entry?: { worker_id?: unknown; op?: unknown }; notice?: { source?: unknown; kind?: unknown } };
        if (method === "loop/terminated" || method === "loop/packet") {
            return typeof payload.workerId === "number" && payload.workerId !== thread.workerId;
        }
        if (method === "notice/event") {
            return typeof payload.workerId === "number"
                && payload.notice?.source === "engine:turn" && payload.notice.kind === "turn_generated";
        }
        if (method === "log/entry") {
            return payload.entry?.worker_id === thread.workerId
                && (payload.entry.op === "WORK" || payload.entry.op === "FORK" || payload.entry.op === "KILL");
        }
        return false;
    }

    // Publish only what differs from the gauge this Run's client holds, and nothing before its snapshot.
    async #refreshStatus(thread: Thread): Promise<void> {
        if (thread.gauge === null) {
            thread.staleGauge = true;
            return;
        }
        const workerId = thread.workerId;
        if (workerId === null) return;
        const refresh = ++thread.gaugeRefresh;
        const [rows, accounting] = await Promise.all([
            this.#seam.listWorkers(thread.workspaceId, { parentWorkerId: workerId }),
            this.#seam.workerAccounting({ workspaceId: thread.workspaceId, workerId }),
        ]);
        if (refresh !== thread.gaugeRefresh || thread.gauge === null) return;
        if (!(this.#threads.get(thread.workspaceId)?.has(thread) ?? false)) return;
        const delta: Parameters<typeof stateDelta>[0] = [];
        const children = aliveChildren(rows);
        if (children !== thread.gauge.children) {
            delta.push({ op: "replace", path: "/plurnk/status/children", value: children });
        }
        const spend = spendState(accounting);
        if (JSON.stringify(spend) !== JSON.stringify(thread.gauge.spend)) {
            delta.push({ op: "replace", path: "/plurnk/status/spend", value: spend });
        }
        thread.gauge = { children, spend };
        if (delta.length > 0) thread.emit([stateDelta(delta)]);
    }

    // The client now holds this status. A refresh asked for before, or racing, its reads runs after it.
    #presentGauge(thread: Thread, status: AguiStatusState): void {
        const stale = thread.staleGauge || thread.gauge !== null;
        thread.gauge = { children: status.children, spend: status.spend };
        thread.staleGauge = false;
        thread.gaugeRefresh += 1;
        if (stale) void this.#refreshStatus(thread);
    }

    // {§agui-delegation-observation} — the actor of a row or stream event that is neither the bound
    // Worker nor a known stranger; null for everything else, so terminals, packets, reasoning and
    // notices stay the bound Worker's alone.
    static #observedActor(thread: Thread, method: string, params: unknown): number | null {
        if (method !== "log/entry" && method !== "stream/event" && method !== "stream/concluded") return null;
        const payload = params as { workerId?: unknown; entry?: { worker_id?: unknown } };
        const actor = method === "log/entry" ? payload.entry?.worker_id : payload.workerId;
        if (typeof actor !== "number" || actor === thread.workerId || thread.unrelated.has(actor)) return null;
        return actor;
    }

    // A descendant's event is introduced once per actor from the daemon's topology, and never touches this Run's step,
    // streams or terminal. The workspace's later events wait for it ({§agui-subagents}).
    async #observeDescendant(workspaceId: number, thread: Thread, actor: number, method: string, params: unknown): Promise<void> {
        let node = thread.tree?.get(actor);
        if (node === undefined && thread.workerId !== null) {
            thread.tree = await this.#descendantTree(workspaceId, thread.workerId);
            node = thread.tree.get(actor);
        }
        if (!(this.#threads.get(workspaceId)?.has(thread) ?? false)) return;
        if (node === undefined) {
            thread.unrelated.add(actor);
            return;
        }
        const subagent = method === "log/entry" ? await this.#rowSubagent(thread, node, (params as LogEntryNotification).entry.loop_id) : null;
        if (!(this.#threads.get(workspaceId)?.has(thread) ?? false)) return;
        // {§agui-delegation-observation} A subagent's start introduces its worker; any other descendant is introduced once
        // before its first event.
        const introduction: AguiEvent[] = thread.introduced.has(actor) || subagent !== null ? []
            : [{ type: EventType.CUSTOM, name: "plurnk.descendant", value: node }];
        thread.introduced.add(actor);
        const out = subagent === null
            ? [...introduction, ...thread.router.route(method, params)]
            : [...Portal.#present(subagent), ...subagent.translator.logEntry(params as LogEntryNotification)];
        if (out.length > 0) thread.emit(out);
    }

    // {§agui-subagents} The subagent a descendant's row belongs to, when a call in view opened its loop.
    async #rowSubagent(thread: Thread, node: Descendant, loopId: number): Promise<Subagent | null> {
        const judged = thread.judged.get(loopId);
        if (judged !== undefined) return judged;
        const loop = (await this.#seam.listWorkerLoops({ workspaceId: thread.workspaceId, workerId: node.workerId })).find(({ id }) => id === loopId);
        if (loop !== undefined) return this.#judge(thread, node, loop);
        const unlisted = Promise.resolve(null);
        thread.judged.set(loopId, unlisted);
        return unlisted;
    }

    // {§agui-subagents} A descendant loop is a subagent of this Run when a call in view opened it: the bound Worker's,
    // or one a subagent of this Run made. Each loop is judged once, from the daemon's record of what opened it, and the
    // live and snapshot projections share the judgment.
    #judge(thread: Thread, node: Descendant, loop: ApplicationLoopProjection): Promise<Subagent | null> {
        let judged = thread.judged.get(loop.id);
        if (judged === undefined) {
            judged = this.#judgeLoop(thread, node, loop);
            thread.judged.set(loop.id, judged);
        }
        return judged;
    }

    async #judgeLoop(thread: Thread, node: Descendant, loop: ApplicationLoopProjection): Promise<Subagent | null> {
        const parent = loop.invocation === null ? null : await this.#opener(thread, loop.invocation);
        if (parent === null) return null;
        const runId = `ops://${node.name}/${loop.sequence}`;
        const subagent: Subagent = {
            runId, loopId: loop.id, workerId: node.workerId, worker: node.name, descendant: node, loopSequence: loop.sequence, parent,
            translator: new Translator({ threadId: thread.threadId, runId: thread.inputRunId, modelWorkerId: node.workerId,
                workspaceId: thread.workspaceId, subagent: { runId, worker: node.name } }),
            // A conclusion still on its way to this Run ends the segment when it arrives.
            result: this.#terminalsDue.has(loop.id) ? null : loop.terminalResult,
            segment: "unstarted",
        };
        thread.subagents.set(loop.id, subagent);
        return subagent;
    }

    // {§agui-subagents} The call that opened a loop, as this Run's client identifies it, when this Run sees it.
    async #opener(thread: Thread, invocation: NonNullable<ApplicationLoopProjection["invocation"]>): Promise<Subagent["parent"] | null> {
        const call = Translator.callOf(invocation.address);
        if (invocation.workerId === thread.workerId) return { call };
        let node = thread.tree?.get(invocation.workerId);
        if (node === undefined && thread.workerId !== null) {
            thread.tree = await this.#descendantTree(thread.workspaceId, thread.workerId);
            node = thread.tree.get(invocation.workerId);
        }
        if (node === undefined) return null;
        const loopSequence = Number(call.split("/")[0]);
        const loop = (await this.#seam.listWorkerLoops({ workspaceId: thread.workspaceId, workerId: node.workerId })).find(({ sequence }) => sequence === loopSequence);
        const subagent = loop === undefined ? null : await this.#judge(thread, node, loop);
        return subagent === null ? null : { call: `${Translator.subagentIds(subagent.worker)}#${call}`, subagent };
    }

    // {§agui-subagents} A subagent's segment of this Run starts the first time the Run presents its work, after its
    // parent's; a loop that concluded before the Run could see it ends it at once.
    static #present(subagent: Subagent): AguiEvent[] {
        if (subagent.segment !== "unstarted") return [];
        const parent = subagent.parent.subagent;
        const events = parent === undefined ? [] : Portal.#present(parent);
        subagent.segment = "open";
        events.push({
            type: EventType.SUBAGENT_STARTED, subagentRunId: subagent.runId, name: subagent.worker, parentToolCallId: subagent.parent.call,
            ...(parent === undefined ? {} : { parentSubagentRunId: parent.runId }),
            metadata: { plurnk: { ...subagent.descendant } },
        });
        if (subagent.result !== null) events.push(...Portal.#end(subagent, subagent.result));
        return events;
    }

    // {§agui-subagents} A loop that completed finishes its subagent with its exact result; any other conclusion, a stop
    // included, is the subagent's error, from its Problem Details.
    static #end(subagent: Subagent, result: OperationResult): AguiEvent[] {
        subagent.segment = "ended";
        const end: AguiEvent = result.status < 400
            ? { type: EventType.SUBAGENT_FINISHED, subagentRunId: subagent.runId, outcome: { type: "success" }, result }
            : { type: EventType.SUBAGENT_ERROR, subagentRunId: subagent.runId, message: result.problem!.detail, code: result.problem!.type };
        return [...subagent.translator.finish(), end];
    }

    // {§agui-subagents} A subagent's loop concluded: an open segment ends now, an unstarted one when it is presented;
    // null for a loop that is no subagent of this Run.
    static #concluded(thread: Thread, terminal: TerminatedNotification): AguiEvent[] | null {
        const subagent = thread.subagents.get(terminal.loopId);
        if (subagent === undefined) return null;
        subagent.result = Validator.assertOperationResult(terminal.result);
        return subagent.segment === "open" ? Portal.#end(subagent, subagent.result) : [];
    }

    // {§agui-subagents} The bound Worker's events, preceded by the end of every subagent segment when they finish the Run.
    static #finishing(thread: Thread, events: AguiEvent[]): AguiEvent[] {
        return events.some(({ type }) => type === EventType.RUN_FINISHED) ? [...Portal.#closeSubagents(thread), ...events] : events;
    }

    // {§agui-subagents} A Run that finishes ends every segment it opened: a subagent still running is suspended, its
    // work going on for a later Run to present, and each subagent's open step closes first.
    static #closeSubagents(thread: Thread): AguiEvent[] {
        return [...thread.subagents.values()].filter(({ segment }) => segment !== "unstarted").flatMap((subagent) => {
            const events = subagent.translator.finish();
            if (subagent.segment === "open") {
                subagent.segment = "ended";
                events.push({ type: EventType.SUBAGENT_FINISHED, subagentRunId: subagent.runId, outcome: { type: "suspended" } });
            }
            return events;
        });
    }

    // {§agui-snapshot} {§agui-subagents} The subagent runs a snapshot replays: each descendant loop a call in view opened,
    // with the rows `history` reads from its worker's log.
    async subagentHistory(thread: unknown, history: (workerId: number) => Promise<Array<Record<string, unknown>>>): Promise<SubagentHistory> {
        const bound = thread as Thread;
        if (!bound.descendants || bound.workerId === null) return [];
        bound.tree = await this.#descendantTree(bound.workspaceId, bound.workerId);
        const parts: Array<SubagentHistory[number]> = [];
        for (const node of [...bound.tree.values()].toSorted((left, right) => left.depth - right.depth)) {
            const loops = await this.#seam.listWorkerLoops({ workspaceId: bound.workspaceId, workerId: node.workerId });
            const subagents = (await Promise.all(loops.map((loop) => this.#judge(bound, node, loop))))
                .filter((subagent): subagent is Subagent => subagent !== null);
            if (subagents.length === 0) continue;
            const rows = await history(node.workerId);
            for (const subagent of subagents) parts.push({ subagent, entries: rows.filter(({ loop_id }) => loop_id === subagent.loopId) });
        }
        return parts;
    }

    async #descendantTree(workspaceId: number, rootId: number): Promise<ReadonlyMap<number, Descendant>> {
        const byId = Portal.#workerMap(await this.#seam.listWorkers(workspaceId));
        const tree = new Map<number, Descendant>();
        for (const candidate of byId.values()) {
            if (candidate.id === rootId || candidate.parentWorkerId === null) continue;
            const depth = Portal.#ancestors(candidate.id, byId).indexOf(rootId) + 1;
            if (depth > 0) tree.set(candidate.id, { workerId: candidate.id, name: candidate.name, parentWorkerId: candidate.parentWorkerId, depth });
        }
        return tree;
    }

    // The stream address a notification opens for the Run that owns it: a started or queued execution
    // row's `attrs.stream`, or a stream/event's target. A detached execution (`<-1>`) is nobody's
    // obligation ({§worker-obligations}) and opens nothing.
    static #openedStream(method: string, params: unknown): string | null {
        if (method === "log/entry") {
            const entry = (params as { entry?: { rx?: { status?: number }; attrs?: { stream?: unknown; detached?: unknown } | null } }).entry;
            if (entry?.rx?.status !== 200 && entry?.rx?.status !== 202) return null;
            const attrs = entry.attrs;
            return typeof attrs?.stream === "string" && attrs.detached !== true ? attrs.stream : null;
        }
        return method === "stream/event" ? Portal.#streamTarget(params) : null;
    }

    static #streamTarget(params: unknown): string {
        const target = (params as { target?: unknown }).target;
        if (typeof target !== "string") throw new Error(`A stream notification names no target: ${JSON.stringify(params)}`);
        return target;
    }

    // {§agui-broadcast-fan} An operation Run shares its runtime Worker with every other client operation and the
    // daemon's own work, so it owns exactly its Loop: that Loop's rows and notices, and the streams those rows
    // announced. Its action result settles it, never the Loop's terminal.
    static #ownsNotification(thread: Thread, method: string, params: unknown): boolean {
        if (thread.notificationScope === "result") return false;
        const operation = thread.notificationScope === "operation";
        const payload = params as {
            workerId?: unknown;
            loopId?: unknown;
            parentWorkerId?: unknown;
            entry?: { worker_id?: unknown; loop_id?: unknown };
        };
        const owns = (workerId: unknown, loopId?: unknown): boolean =>
            typeof workerId === "number"
            && workerId === thread.workerId
            && (operation
                ? thread.loopId !== null && loopId === thread.loopId
                : thread.loopId === null || typeof loopId !== "number" || loopId === thread.loopId);
        switch (method) {
            case "workspace/preparation": return true;
            case "log/entry": return owns(payload.entry?.worker_id, payload.entry?.loop_id);
            case "loop/terminated": return !operation && owns(payload.workerId, payload.loopId);
            case "loop/packet":
            case "reasoning/event":
            case "outside/event": return owns(payload.workerId, payload.loopId);
            case "notice/event": return payload.workerId === null
                ? thread.notificationScope === "worker"
                : owns(payload.workerId, payload.loopId);
            case "stream/event":
            case "stream/concluded": return operation
                ? payload.workerId === thread.workerId && thread.openStreams.has(Portal.#streamTarget(params))
                : owns(payload.workerId);
            default: return false;
        }
    }

    // A stream of an operation Run's Worker that no row of its Loop has announced: it may be this Run's own
    // execution whose row is still to arrive, so its latest snapshot and conclusion wait for that row.
    static #holdUnannounced(thread: Thread, method: string, params: unknown): void {
        if (thread.notificationScope !== "operation" || thread.loopId === null) return;
        if (method !== "stream/event" && method !== "stream/concluded") return;
        if ((params as { workerId?: unknown }).workerId !== thread.workerId) return;
        const target = Portal.#streamTarget(params);
        const held = thread.unannounced.get(target) ?? { event: null, concluded: null };
        thread.unannounced.set(target, method === "stream/event" ? { ...held, event: params } : { ...held, concluded: params });
    }

    // The row that announces a stream delivers what it held, in order; a stream already concluded stays closed.
    #releaseUnannounced(thread: Thread, target: string): void {
        const held = thread.unannounced.get(target);
        if (held === undefined) return;
        thread.unannounced.delete(target);
        if (held.event !== null) {
            const out = thread.router.route("stream/event", held.event);
            if (out.length > 0) thread.emit(out);
        }
        if (held.concluded !== null) {
            thread.openStreams.delete(target);
            const out = thread.router.route("stream/concluded", held.concluded);
            if (out.length > 0) thread.emit(out);
        }
    }

    stop(): void {
        if (this.#stopped) return;
        this.#stopped = true;
        this.#hitl.stop();
        this.#off?.();
        this.#off = null;
        this.#continuations.clear();
        // {§agui-shutdown} Module close follows core settlement; remaining Runs are
        // transport lifetimes, not unfinished worker obligations to await again.
        for (const threads of this.#threads.values()) {
            for (const thread of threads) this.failThread(thread, runErrorEvents(serviceStoppingProblem()));
        }
        this.#threads.clear();
    }

    #emitDelivery(
        workspaceId: number,
        delivery: HitlDelivery,
        threads: readonly Thread[],
    ): void {
        if (delivery.batch.events.length === 0) return;
        for (const thread of threads) {
            const controlLoopId = thread.loopId
                ?? (thread.workerId === delivery.workerId ? delivery.loopId : null);
            // {§agui-gate-deferral} — the first gate waits on the open lifecycle; a later one stays durable
            // and re-surfaces after the first resolves.
            if (thread.router.reasoningOpen) {
                thread.deferredDelivery ??= delivery;
                continue;
            }
            const paused = thread.router.interrupt();
            const continuation: InterruptContinuation = {
                cancelOnDisconnect: thread.cancelOnDisconnect,
                workspaceId,
                owner: delivery.recipient,
                gate: { workerId: delivery.workerId, loopId: delivery.loopId },
                binding: { workerId: thread.workerId, loopId: controlLoopId },
                modelWorkerId: thread.modelWorkerId,
                threadId: thread.threadId,
                state: {
                    ...paused.continuation,
                    currentTurn: paused.continuation.currentTurn
                        ?? (thread.workerId === delivery.workerId ? delivery.turnId : null),
                },
            };
            const interrupts = delivery.batch.interrupts.map((original) => {
                const interrupt = { ...original, id: crypto.randomUUID() };
                this.#continuations.set(interrupt.id, {
                    toolCallId: original.toolCallId ?? original.id,
                    continuation,
                });
                return interrupt;
            });
            // {§agui-subagents} The interrupt finishes the Run, so its subagents' segments end before it.
            const closed = interrupts.length > 0 ? Portal.#closeSubagents(thread) : [];
            this.#withHitl({ events: delivery.batch.events, interrupts }, () => {
                thread.emit([...delivery.batch.events, ...paused.events, ...closed]);
            });
        }
    }

    #presentDeferred(workspaceId: number, thread: Thread): void {
        const delivery = thread.deferredDelivery;
        if (delivery === null || thread.router.reasoningOpen) return;
        thread.deferredDelivery = null;
        this.#emitDelivery(workspaceId, delivery, [thread]);
    }

    #withHitl(batch: HitlBatch, emit: (events: AguiEvent[]) => void): void {
        for (const interrupt of batch.interrupts) {
            this.#activeInterrupts.set(interrupt.toolCallId ?? interrupt.id, interrupt);
        }
        try {
            emit(batch.events);
        } finally {
            for (const interrupt of batch.interrupts) {
                this.#activeInterrupts.delete(interrupt.toolCallId ?? interrupt.id);
            }
        }
    }

    // {§agui-worker-owner} A gate reaches its owner's Runs that observe a worker: the one bound to its worker, else
    // every one. An operation or result Run never presents one.
    #routeHitl(workspaceId: number, delivery: HitlDelivery): void {
        const threads = [...(this.#threads.get(workspaceId) ?? [])]
            .filter((thread) => thread.owner === delivery.recipient && thread.notificationScope === "worker");
        const exact = threads.filter((thread) => thread.workerId === delivery.workerId);
        this.#emitDelivery(workspaceId, delivery, exact.length > 0 ? exact : threads);
    }

    #enqueueDelivery(workspaceId: number, task: () => Promise<void>): void {
        const prior = this.#deliveryTails.get(workspaceId) ?? Promise.resolve();
        const delivery = prior.then(task).catch((cause: unknown) => {
            console.error("AG-UI stopped-world routing failed:", cause);
        });
        this.#deliveryTails.set(workspaceId, delivery);
        void delivery.finally(() => {
            if (this.#deliveryTails.get(workspaceId) === delivery) {
                this.#deliveryTails.delete(workspaceId);
            }
        });
    }

    static #workerMap(
        workers: readonly ApplicationWorkerProjection[],
    ): ReadonlyMap<number, ApplicationWorkerProjection> {
        const byId = new Map<number, ApplicationWorkerProjection>();
        for (const worker of workers) {
            if (byId.has(worker.id)) throw new Error(`worker topology repeats worker ${worker.id}`);
            byId.set(worker.id, worker);
        }
        for (const worker of workers) {
            if (worker.parentWorkerId !== null && !byId.has(worker.parentWorkerId)) {
                throw new Error(
                    `worker topology omits parent ${worker.parentWorkerId} of worker ${worker.id}`,
                );
            }
        }
        return byId;
    }

    static #ancestors(
        workerId: number,
        byId: ReadonlyMap<number, ApplicationWorkerProjection>,
    ): number[] {
        const worker = byId.get(workerId);
        if (worker === undefined) throw new Error(`worker topology omits worker ${workerId}`);
        const ancestors: number[] = [];
        const visited = new Set([workerId]);
        let parentWorkerId = worker.parentWorkerId;
        while (parentWorkerId !== null) {
            if (visited.has(parentWorkerId)) throw new Error(`worker topology contains a cycle at ${parentWorkerId}`);
            visited.add(parentWorkerId);
            ancestors.push(parentWorkerId);
            const parent = byId.get(parentWorkerId);
            if (parent === undefined) throw new Error(`worker topology omits worker ${parentWorkerId}`);
            parentWorkerId = parent.parentWorkerId;
        }
        return ancestors;
    }

    async #activeLoopId(workspaceId: number, workerId: number): Promise<number | null> {
        const active = selectWorkerLoop((await this.#seam.listWorkerLoops({ workspaceId, workerId }))
            .filter(({ terminatedAt, terminalResult }) => terminatedAt === null && terminalResult === null));
        return active?.id ?? null;
    }

    // {§agui-action-binding} The model worker the Run that presented these interrupts bound, which their
    // resume binds in turn; undefined when it bound none or the set names no one presentation of this thread.
    resumedWorker(workspaceId: number, threadId: string, resume: readonly ResumeEntry[]): number | undefined {
        const continuations = resume.map(({ interruptId }) => this.#continuations.get(interruptId)?.continuation);
        const first = continuations[0];
        if (first === undefined || continuations.some((candidate) => candidate !== first)) return undefined;
        if (first.workspaceId !== workspaceId || first.threadId !== threadId) return undefined;
        return first.modelWorkerId ?? undefined;
    }

    interruptForToolCall(toolCallId: string): Interrupt | null {
        return this.#activeInterrupts.get(toolCallId) ?? null;
    }

    // Bind a client's SSE to a workspace and AG-UI Run. The emit consumer ends its stream when it
    // sees RUN_FINISHED / RUN_ERROR (the router's terminal projection) — the engine
    // owns notification routing; the edge owns the socket lifecycle. `workerId` is the Worker the Run observes,
    // null for one that observes none or, for an operation Run, until bindOperation; `modelWorkerId` is the model
    // worker the Run binds and renders, null when it binds none ({§agui-action-binding}).
    openThread(args: { workspaceId: number; workerId: number | null; threadId: string; owner?: string; family?: string | null; notificationScope: NotificationScope; emit: (events: AguiEvent[]) => void; modelWorkerId?: number | null; inputRunId?: string; resume?: ResumeEntry[]; descendants?: boolean; cancelOnDisconnect?: boolean }): unknown {
        if (this.#stopped) throw new HttpProblemError(serviceStoppingProblem());
        const candidates = args.resume
            ?.map(({ interruptId }) => this.#continuations.get(interruptId)?.continuation) ?? [];
        const first = candidates[0];
        const restored = first !== undefined && candidates.every((candidate) => candidate === first)
            && first.workspaceId === args.workspaceId && first.owner === args.owner && first.threadId === args.threadId
            ? first : undefined;
        const continuation = restored?.state;
        const router = new EventRouter({
            threadId: args.threadId,
            runId: args.inputRunId ?? String(args.workerId),
            modelWorkerId: args.modelWorkerId ?? null,
            workspaceId: args.workspaceId,
            ...(continuation === undefined ? {} : { continuation }),
        });
        const t: Thread = {
            workspaceId: args.workspaceId,
            owner: args.owner ?? null,
            family: args.family ?? null,
            workerId: restored?.binding.workerId ?? args.workerId,
            loopId: restored?.binding.loopId ?? null,
            notificationScope: args.notificationScope,
            modelWorkerId: args.modelWorkerId ?? null,
            router,
            emit: args.emit,
            threadId: args.threadId,
            inputRunId: args.inputRunId ?? String(args.workerId),
            openStreams: new Set(),
            unannounced: new Map(),
            deferredFinish: null,
            pendingTerminations: [],
            resolvingInterrupts: args.resume !== undefined,
            cancelOnDisconnect: restored?.cancelOnDisconnect ?? args.cancelOnDisconnect === true,
            disconnected: false,
            deferredDelivery: null,
            descendants: args.descendants === true,
            tree: null,
            introduced: new Set(),
            unrelated: new Set(),
            judged: new Map(),
            subagents: new Map(),
            gauge: null,
            staleGauge: false,
            gaugeRefresh: 0,
        };
        let set = this.#threads.get(args.workspaceId);
        if (set === undefined) { set = new Set(); this.#threads.set(args.workspaceId, set); }
        set.add(t);
        return t;
    }

    closeRun(workspaceId: number, t: unknown): void { this.#threads.get(workspaceId)?.delete(t as Thread); }

    // {§agui-run-disconnect} A message Run cancels its bound worker; an operation Run cancels exactly its own Loop,
    // at once when known, else when its dispatch opens it.
    disconnect(thread: unknown): void {
        const bound = thread as Thread;
        if (bound.disconnected) return;
        bound.disconnected = true;
        if (bound.cancelOnDisconnect) this.#cancelOwned(bound);
    }

    #cancelOwned(thread: Thread): void {
        if (thread.notificationScope === "operation") {
            const loopId = thread.loopId;
            if (loopId === null) return;
            void this.#seam.cancelLoop({ workspaceId: thread.workspaceId, loopId, reason: "client_disconnected" }).catch((cause: unknown) => {
                console.error(`AG-UI: cancelling client operation loop ${loopId} failed:`, cause);
            });
            return;
        }
        if (thread.workerId !== null) this.#seam.cancelDrain(thread.workerId, "client_disconnected");
    }

    // {§agui-broadcast-fan} An operation Run observes the Loop its dispatch opened, from before any statement runs.
    bindOperation(thread: unknown, loop: { readonly workerId: number; readonly loopId: number }): void {
        const bound = thread as Thread;
        bound.workerId = loop.workerId;
        bound.loopId = loop.loopId;
        if (bound.disconnected && bound.cancelOnDisconnect) this.#cancelOwned(bound);
    }

    // {§agui-status-children} {§agui-status-spend} — the snapshot is the gauge the status deltas patch.
    runStarted(thread: unknown, state?: AguiEvent): AguiEvent[] {
        const bound = thread as Thread;
        const events = bound.router.runStarted(state);
        const status = state?.type === EventType.STATE_SNAPSHOT
            ? (state.snapshot as { plurnk?: { status?: AguiStatusState } }).plurnk?.status
            : undefined;
        if (status !== undefined) this.#presentGauge(bound, status);
        return events;
    }

    // A whole-gauge replacement: the client's gauge is this status from here on.
    replaceStatus(thread: unknown, status: AguiStatusState): AguiEvent[] {
        this.#presentGauge(thread as Thread, status);
        return [stateDelta([{ op: "replace", path: "/plurnk/status", value: status }])];
    }

    // {§agui-snapshot} {§agui-subagents} The conversation, then the subagent runs it holds, each presented.
    replay(thread: unknown, entries: Array<Record<string, unknown>>, currentUser?: UserMessage, subagents: SubagentHistory = []): AguiEvent[] {
        return [
            ...(thread as Thread).router.replay(entries, currentUser, subagents.map(({ subagent, entries: rows }) => ({ translator: subagent.translator, entries: rows }))),
            ...subagents.flatMap(({ subagent }) => Portal.#present(subagent)),
        ];
    }

    #finishThread(thread: Thread, events: AguiEvent[], result: unknown): void {
        const finished: AguiEvent = { type: EventType.RUN_FINISHED, threadId: thread.threadId, runId: thread.inputRunId, outcome: { type: "success" },
            ...(result === undefined ? {} : { result }) };
        thread.emit([...events, ...thread.router.finish(), ...Portal.#closeSubagents(thread), finished]);
    }

    // The Run finishes with `events`, and `result` as its result when it has one.
    finishThread(thread: unknown, events: AguiEvent[], result?: unknown): void {
        const bound = thread as Thread;
        if (bound.openStreams.size > 0) {
            bound.deferredFinish = { events, result };
            return;
        }
        this.#finishThread(bound, events, result);
    }

    failThread(thread: unknown, events: AguiEvent[]): void {
        const bound = thread as Thread;
        bound.emit([...bound.router.fail(), ...events]);
    }

    // {§agui-oauth-revocation} — every Run admitted under the family ends with the given events; the
    // loops those Runs observed continue, since a revoked observer is not a cancelling one.
    failFamily(family: string, events: AguiEvent[]): void {
        for (const threads of this.#threads.values()) {
            for (const thread of threads) {
                if (thread.family !== family) continue;
                this.failThread(thread, events);
                threads.delete(thread);
            }
        }
    }

    async #resurfaceControlled(workspaceId: number, thread: Thread): Promise<boolean> {
        if (thread.owner === null) return false;
        const deliveries = await this.#hitl.resurface(workspaceId, thread.owner);
        const pendingIds = new Set(deliveries.flatMap(({ batch }) => batch.interrupts.map(({ toolCallId, id }) => toolCallId ?? id)));
        for (const [id, candidate] of this.#continuations) {
            if (candidate.continuation.workspaceId === workspaceId && candidate.continuation.owner === thread.owner
                && !pendingIds.has(candidate.toolCallId)) this.#continuations.delete(id);
        }
        if (deliveries.length === 0) return false;
        const delivery = deliveries.find(({ workerId }) => thread.workerId === workerId) ?? deliveries[0];
        if (delivery === undefined) return false;
        if (thread.loopId === null) {
            thread.loopId = delivery.workerId === thread.workerId
                ? delivery.loopId
                : thread.workerId === null ? null : await this.#activeLoopId(workspaceId, thread.workerId);
        }
        this.#emitDelivery(workspaceId, delivery, [thread]);
        return true;
    }

    #bindLoop(thread: Thread, loopId: number): boolean {
        thread.loopId = loopId;
        const terminal = thread.pendingTerminations.find(
            (params) => (params as { loopId?: unknown }).loopId === loopId,
        );
        thread.pendingTerminations = [];
        if (terminal === undefined) return false;
        const out = Portal.#finishing(thread, thread.router.route("loop/terminated", terminal));
        if (out.length > 0) thread.emit(out);
        return true;
    }

    // Synchronize one AG-UI observer with the bound worker's durable log. A pending
    // stopped-world is re-presented first; otherwise an active Loop stays attached
    // and an idle worker settles immediately. Returns true only while this
    // thread remains attached to independently-owned live work.
    async synchronize(workspaceId: number, thread: unknown, waitForWork = false): Promise<boolean> {
        const bound = thread as Thread;
        if (bound.workerId === null) throw new Error("a synchronization Run reached the Portal without its worker");
        if (await this.#resurfaceControlled(workspaceId, bound)) return false;
        const loop = selectWorkerLoop((await this.#seam.listWorkerLoops({ workspaceId, workerId: bound.workerId }))
            .filter(({ terminatedAt, terminalResult }) => terminatedAt === null && terminalResult === null));
        if (loop === null) {
            if (waitForWork) return true;
            this.finishThread(bound, []);
            return false;
        }
        return !this.#bindLoop(bound, loop.id);
    }

    // Drive a prompt through the loop (fire-and-forget — the outcome streams via the
    // subscription as loop/terminated). {§agui-message-before-gate} — the prompt is durable in
    // Core before any pending stopped-world is re-presented.
    async run(thread: unknown, args: Parameters<ApplicationPort["runLoop"]>[0]): Promise<{ loopId: number } | null> {
        const bound = thread as Thread;
        // {§agui-snapshot} The submitting Run's client holds its own message; every other Run receives it.
        const submitted = (args.envelope?.message as { id?: unknown } | undefined)?.id;
        if (typeof submitted === "string") bound.router.submitted(submitted);
        const ack = await this.#seam.runLoop(args);
        if (bound.disconnected) {
            if (bound.cancelOnDisconnect) this.#cancelOwned(bound);
            return null;
        }
        if (!this.#threads.get(args.workspaceId)?.has(bound)) return null;
        if (await this.#resurfaceControlled(args.workspaceId, bound)) return null;
        this.#bindLoop(bound, ack.loopId);
        return { loopId: ack.loopId };
    }

    cancel(workerId: number): boolean { return this.#seam.cancelDrain(workerId); }

    // A standard resume AG-UI Run binds to its presentation's continuation before
    // releasing every addressed interrupt.
    async resolve(workspaceId: number, thread: unknown, entries: ResumeEntry[]): Promise<void> {
        const bound = thread as Thread;
        if (bound.owner === null) throw new Error("an observer cannot resolve interrupts");
        bound.resolvingInterrupts = true;
        const continuations = entries.map(({ interruptId }) => this.#continuations.get(interruptId));
        const recorded = continuations.filter(
            (continuation): continuation is PresentedInterrupt => continuation !== undefined,
        );
        if (recorded.length !== entries.length || recorded.length === 0) {
            throw new HttpProblemError(Problems.create("agui:interrupt", "interrupt-not-pending", 409,
                "The resume addresses an unknown interrupt presentation.", {
                    stage: "interrupt-resolution", retryable: false,
                    recovery: "Refresh pending interrupts before resuming.",
                }));
        }
        const continuation = recorded[0]!.continuation;
        if (recorded.some((candidate) => candidate.continuation !== continuation)) {
            throw new HttpProblemError(Problems.create("agui:interrupt", "interrupt-binding-invalid", 400,
                "The resume combines interrupts from different Runs."));
        }
        const resolutions = entries.map((entry, index) => ({ ...entry, interruptId: recorded[index]!.toolCallId }));
        await this.#hitl.resolve(workspaceId, bound.owner, resolutions, (resolution) => {
            if (continuation.workspaceId !== workspaceId
                || continuation.owner !== bound.owner
                || continuation.threadId !== bound.threadId
                || continuation.gate.workerId !== resolution.workerId
                || continuation.gate.loopId !== resolution.loopId) {
                throw new HttpProblemError(Problems.create("agui:interrupt", "interrupt-binding-invalid", 400,
                    "The resume does not match its interrupt's binding."));
            }
            bound.workerId = continuation.binding.workerId;
            bound.loopId = continuation.binding.loopId;
            bound.cancelOnDisconnect = continuation.cancelOnDisconnect;
            if (bound.disconnected) throw new HttpProblemError(Problems.create("agui:interrupt", "connection-closed", 499,
                "The connection closed before the interrupt was resolved."));
        });
        bound.emit(resolutions.map((entry) => ({
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: entry.interruptId,
            messageId: `${entry.interruptId}/result`,
            content: JSON.stringify({ status: entry.status, payload: entry.payload ?? null }),
        })));
        // {§agui-proposal-resolve} A stale or expired answer owns its failure,
        // even when the previously interrupted loop has already terminated.
        bound.resolvingInterrupts = false;
        if (bound.loopId !== null) this.#bindLoop(bound, bound.loopId);
        const resolvedIds = new Set(resolutions.map(({ interruptId }) => interruptId));
        for (const [id, candidate] of this.#continuations) {
            if (candidate.continuation.workspaceId === workspaceId && resolvedIds.has(candidate.toolCallId)) this.#continuations.delete(id);
        }
        if (this.#threads.get(workspaceId)?.has(bound)) {
            const surfaced = await this.#resurfaceControlled(workspaceId, bound);
            if (!surfaced && bound.loopId === null) this.finishThread(bound, []);
        }
    }
}
