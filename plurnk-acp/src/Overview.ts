// {§acp-overview} The worker overview: an ACP Run that binds no workspace and no worker and carries the places of the
// daemon, or of one workspace, as standard state ({§application-worker-overview}). A connected observer is read again after
// each event in its scope that can change it and receives what changed as RFC 6902 patches.
import type { ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { Problems, type ApplicationOverviewWorker, type ApplicationOverviewWorkspace, type ApplicationWorkerOverview } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { httpProblem, runErrorEvents } from "./run-events.ts";
import { EventType, type AcpEvent, type RunAgentInput } from "./types.ts";

export type OverviewSeam = Pick<ApplicationPort, "readWorkerOverview" | "subscribeToEvents">;

/** {§acp-overview} A worker as the overview's state carries it: its reply's words by reference. */
export type OverviewWorker = Omit<ApplicationOverviewWorker, "reply"> & {
    readonly reply: (NonNullable<ApplicationOverviewWorker["reply"]> & { readonly body: { readonly url: string; readonly mimeType: string } }) | null;
};

/** {§acp-overview} The overview a client holds: workspaces and workers by id, the held workers in order, and the rest counted. */
export interface OverviewState {
    readonly scope: { readonly workspaceId: number | null };
    readonly workspaces: Readonly<Record<string, ApplicationOverviewWorkspace>>;
    readonly workers: Readonly<Record<string, OverviewWorker>>;
    readonly recent: readonly number[];
    readonly omitted: number;
}

// An RFC 6902 operation on the overview's state.
export type OverviewPatch =
    | { readonly op: "add" | "replace"; readonly path: string; readonly value: unknown }
    | { readonly op: "remove"; readonly path: string };

// Events that never change the overview: streamed reasoning, outside text and stream chunks.
const QUIET: ReadonlySet<string> = new Set(["reasoning/event", "outside/event", "stream/event"]);

interface Observer {
    readonly workspaceId: number | null;
    readonly origin: string;
    readonly family: string | null;
    readonly emit: (events: AcpEvent[]) => void;
    readonly end: (events: AcpEvent[]) => void;
    held: OverviewState | null;
    reading: boolean;
    again: boolean;
}

export default class Overview {
    readonly #seam: () => OverviewSeam;
    readonly #bounds: () => { readonly limit: number; readonly excerptChars: number; readonly heartbeatMs: number };
    readonly #track: <T>(work: Promise<T>) => Promise<T>;
    readonly #observers = new Set<Observer>();
    #off: (() => void) | null = null;

    constructor({ seam, bounds, track }: {
        seam: () => OverviewSeam;
        bounds: () => { readonly limit: number; readonly excerptChars: number; readonly heartbeatMs: number };
        track: <T>(work: Promise<T>) => Promise<T>;
    }) {
        this.#seam = seam;
        this.#bounds = bounds;
        this.#track = track;
    }

    // {§acp-overview-state} The overview as its state carries it: workspaces and workers by id, each reply's words by
    // reference at the entry route ({§acp-entry-route}), the held workers in order.
    static state(overview: ApplicationWorkerOverview, workspaceId: number | null, origin: string): OverviewState {
        const body = (worker: ApplicationOverviewWorker, coordinate: string) => ({
            url: `${origin}/acp/${worker.workspaceId}/${worker.id}/entry?${new URLSearchParams({ target: `log:///${coordinate}/SEND` })}`,
            mimeType: "text/plain",
        });
        return {
            scope: { workspaceId },
            workspaces: Object.fromEntries(overview.workspaces.map((workspace) => [String(workspace.id), workspace])),
            workers: Object.fromEntries(overview.workers.map((worker) => [String(worker.id), {
                ...worker, reply: worker.reply === null ? null : { ...worker.reply, body: body(worker, worker.reply.coordinate) },
            }])),
            recent: overview.workers.map(({ id }) => id),
            omitted: overview.omitted,
        };
    }

    // {§acp-overview-updates} The patches that take `held` to `next`: each workspace and worker added, replaced or removed
    // by id, then the order and the count left out when they change.
    static patches(held: OverviewState, next: OverviewState): OverviewPatch[] {
        const patches: OverviewPatch[] = [];
        for (const key of ["workspaces", "workers"] as const) {
            for (const [id, value] of Object.entries(next[key])) {
                const before = held[key][id];
                if (before === undefined) patches.push({ op: "add", path: `/plurnk/overview/${key}/${id}`, value });
                else if (!isDeepStrictEqual(before, value)) patches.push({ op: "replace", path: `/plurnk/overview/${key}/${id}`, value });
            }
            for (const id of Object.keys(held[key])) {
                if (next[key][id] === undefined) patches.push({ op: "remove", path: `/plurnk/overview/${key}/${id}` });
            }
        }
        if (!isDeepStrictEqual(held.recent, next.recent)) patches.push({ op: "replace", path: "/plurnk/overview/recent", value: next.recent });
        if (held.omitted !== next.omitted) patches.push({ op: "replace", path: "/plurnk/overview/omitted", value: next.omitted });
        return patches;
    }

    // One subscription for every observer: an event in an observer's scope reads its overview again.
    start(): void {
        this.#off = this.#seam().subscribeToEvents((workspaceId, method) => {
            if (workspaceId === null || QUIET.has(method)) return;
            for (const observer of this.#observers) {
                if (observer.workspaceId === null || observer.workspaceId === workspaceId) this.#schedule(observer);
            }
        });
    }

    // {§acp-shutdown} Every observation ends with `events`.
    stop(events: AcpEvent[]): void {
        this.#off?.();
        this.#off = null;
        for (const observer of this.#observers) observer.end(events);
        this.#observers.clear();
    }

    // {§acp-oauth-revocation} The observations admitted under `family` end with `events`.
    failFamily(family: string, events: AcpEvent[]): void {
        for (const observer of this.#observers) {
            if (observer.family !== family) continue;
            observer.end(events);
            this.#observers.delete(observer);
        }
    }

    // {§acp-overview-run} A Run of the overview: its snapshot, then, for a connected observer, what changes until it leaves.
    // The scope is read before anything is written, so a refusal is the request's own.
    async observe(input: RunAgentInput, res: ServerResponse, request: {
        readonly workspaceId: number | null;
        readonly live: boolean;
        readonly origin: string;
        readonly family: string | null;
    }): Promise<void> {
        let finished = false;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        const finish = (): void => {
            if (finished) return;
            finished = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            this.#observers.delete(observer);
            res.end();
        };
        const write = (events: AcpEvent[]): void => {
            if (finished) return;
            for (const event of events) {
                res.write(`data: ${JSON.stringify(event)}\n\n`);
                if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) finish();
            }
        };
        // An ending that comes while the first read is under way ends the Run once it opens.
        let opened = false;
        let ending: AcpEvent[] | null = null;
        const end = (events: AcpEvent[]): void => {
            if (opened) write(events);
            else ending = events;
        };
        const observer: Observer = { workspaceId: request.workspaceId, origin: request.origin, family: request.family,
            emit: write, end, held: null, reading: true, again: false };
        // Watching before the first read: an event that lands while it reads, reads again after it.
        if (request.live) this.#observers.add(observer);
        let first: OverviewState;
        try {
            first = await this.#read(observer);
        } catch (cause) {
            this.#observers.delete(observer);
            throw cause;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
        opened = true;
        observer.held = first;
        write([
            { type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId },
            { type: EventType.STATE_SNAPSHOT, snapshot: { plurnk: { overview: first } } },
        ]);
        if (ending !== null) {
            write(ending);
            return;
        }
        if (!request.live) {
            write([{ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: "success" } }]);
            return;
        }
        // {§acp-configuration} SSE comments keep a quiet observation connected; the client leaving ends it.
        const cadence = this.#bounds().heartbeatMs;
        if (cadence > 0) heartbeat = setInterval(() => { res.write(": hb\n\n"); }, cadence);
        res.once("close", finish);
        if (res.destroyed) { finish(); return; }
        observer.reading = false;
        if (observer.again) {
            observer.again = false;
            this.#schedule(observer);
        }
    }

    #read(observer: Observer): Promise<OverviewState> {
        const { limit, excerptChars } = this.#bounds();
        return this.#track(this.#seam().readWorkerOverview({
            ...(observer.workspaceId === null ? {} : { workspaceId: observer.workspaceId }), limit, excerptChars,
        })).then((overview) => Overview.state(overview, observer.workspaceId, observer.origin));
    }

    // {§acp-overview-updates} A burst of events reads the overview once: a read already under way reads again when it ends.
    #schedule(observer: Observer): void {
        if (observer.reading) {
            observer.again = true;
            return;
        }
        observer.reading = true;
        setImmediate(() => { void this.#refresh(observer); });
    }

    async #refresh(observer: Observer): Promise<void> {
        try {
            if (!this.#observers.has(observer) || observer.held === null) return;
            const next = await this.#read(observer);
            if (!this.#observers.has(observer)) return;
            const patches = Overview.patches(observer.held, next);
            observer.held = next;
            if (patches.length > 0) observer.emit([{ type: EventType.STATE_DELTA, delta: [...patches] }]);
        } catch (cause) {
            const problem = Problems.fromError(cause);
            if (problem === null) console.error("ACP overview read failed:", cause);
            observer.end(runErrorEvents(problem ?? httpProblem("overview-read-failed", 500, "The overview read failed.", { stage: "overview", retryable: true })));
            this.#observers.delete(observer);
        } finally {
            observer.reading = false;
            if (observer.again && this.#observers.has(observer)) {
                observer.again = false;
                this.#schedule(observer);
            }
        }
    }
}
