// The durable writes a turn makes beside its packet: environment and stream deltas, filesystem fictions, message arrivals. Split out of TurnRunner.
import type { Db } from "./Db.ts";
import { type FsDivergence } from "./git-membership.ts";
import { type GitStatusSnapshot } from "./git-state.ts";
import { editedSpan } from "../content/index.ts";
import ReadResolve from "../content/read-resolve.ts";
import ReadProjector from "../content/read-projector.ts";
import Loop from "../schemes/Loop.ts";
import { authorityParts } from "./plurnk-uri.ts";
import Results, { type SchemeResult } from "./results.ts";
import TerminalResult from "./TerminalResult.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Turn from "./Turn.ts";
import RuntimeWorker from "./RuntimeWorker.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

export default class TurnMaterialization {
    readonly #db: Db;
    readonly #weighContent: (text: string) => number;
    readonly #mimetypes: Mimetypes;

    constructor({ db, weighContent, mimetypes }: {
        db: Db;
        weighContent: (text: string) => number;
        mimetypes: Mimetypes;
    }) {
        this.#db = db;
        this.#weighContent = weighContent;
        this.#mimetypes = mimetypes;
    }

    async materializeEnvironmentDeltas(args: {
        workspaceId: number; workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number[]> {
        const { workspaceId, workerId, loopId, turnId, fromSequence } = args;
        const rows = await this.#db.engine_pull_ambient_events.all<{
            cursor: number;
            boundary: number;
            event_id: number | null;
            producer_worker_id: number | null;
            producer_worker_name: string | null;
            kind: "activity" | "loop_termination" | "reply" | null;
            source: string | null;
            at: string | null;
            op: string | null;
            signal: string | null;
            scheme: string | null;
            username: string | null;
            password: string | null;
            hostname: string | null;
            port: number | null;
            pathname: string | null;
            query: string | null;
            fragment: string | null;
            line_marker: string | null;
            tx: string | null;
            mimetype_tx: string | null;
            rx: string | null;
            mimetype_rx: string | null;
            state: "resolved" | "failed" | "cancelled" | null;
            outcome: string | null;
            attrs: string | null;
            status_rx: number | null;
            terminated_by: string | null;
        }>({ workspace_id: workspaceId, worker_id: workerId });
        const window = rows[0];
        if (window === undefined) throw new Error(`ambient pull: worker ${workerId} has no observation window`);
        const entryIds: number[] = [];
        for (const r of rows) {
            if (r.event_id === null || r.producer_worker_id === null || r.producer_worker_name === null || r.kind === null
                || r.at === null || r.op === null || r.tx === null || r.mimetype_tx === null
                || r.rx === null || r.mimetype_rx === null || r.status_rx === null || r.state === null) continue;
            const termination = r.kind === "loop_termination";
            const terminal = termination
                ? TerminalResult.parse(r.rx, `ambient loop-termination event ${r.event_id}`)
                : null;
            if (terminal !== null && terminal.status !== r.status_rx) {
                throw new Error(`ambient loop-termination event ${r.event_id} status ${r.status_rx} does not match its terminal result status ${terminal.status}`);
            }
            let attrs = r.attrs ?? "{}";
            let rx = r.rx;
            if (terminal !== null) {
                const inherited = JSON.parse(attrs) as unknown;
                if (inherited === null || typeof inherited !== "object" || Array.isArray(inherited)) {
                    throw new TypeError(`ambient loop-termination event ${r.event_id} attrs must be an object`);
                }
                attrs = JSON.stringify({
                    ...inherited,
                    kind: "loop_termination",
                    ...(r.terminated_by === null ? {} : { terminatedBy: r.terminated_by }),
                });
                const resource = `loop://${r.hostname}${r.pathname}`;
                rx = JSON.stringify(await ReadProjector.project({
                    statement: { op: "READ", target: null, lineMarker: null, matcher: null, metadata: null,
                        body: null, aside: null, position: { line: 1, column: 1 } },
                    manifest: Loop.manifest, publishesLineAnchors: false,
                    target: resource, identity: resource, mimetypes: this.#mimetypes,
                    representation: TerminalResult.representation(terminal, resource, r.terminated_by),
                }));
            }
            const inserted = await this.#db.engine_insert_ambient_delta.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + entryIds.length,
                at: r.at,
                event_id: r.event_id,
                source: WorkerControlAddress.render(r.producer_worker_name),
                op: r.op,
                signal: r.signal,
                scheme: r.scheme,
                username: r.username,
                password: r.password,
                hostname: r.hostname,
                port: r.port,
                pathname: r.pathname,
                query: r.query,
                fragment: r.fragment,
                line_marker: r.line_marker,
                tx: r.tx,
                mimetype_tx: r.mimetype_tx,
                rx,
                mimetype_rx: r.mimetype_rx,
                status: r.status_rx,
                weight: LogBody.weight({
                    op: r.op,
                    attrs,
                    tx: r.tx,
                    rx,
                    mimetypeTx: r.mimetype_tx,
                    mimetypeRx: r.mimetype_rx,
                }, this.#weighContent),
                state: r.state,
                outcome: r.outcome,
                folded: LogVisibility.serialize(terminal !== null || r.kind === "reply" ? LogVisibility.OPEN : LogVisibility.FOLDED),
                attrs,
            });
            const materialized = inserted ?? await this.#db.engine_ambient_delta_id.get<{ id: number }>({
                worker_id: workerId,
                event_id: r.event_id,
            });
            if (materialized === undefined) throw new Error(`ambient event ${r.event_id} has no observer log row after materialization`);
            if (inserted !== undefined) entryIds.push(inserted.id);
        }
        await this.#db.engine_advance_ambient_cursor.get({
            workspace_id: workspaceId,
            worker_id: workerId,
            cursor: window.cursor,
            boundary: window.boundary,
        });
        return entryIds;
    }


    async materializeStreamDeltas(args: {
        workspaceId: number; workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number[]> {
        const { workerId, loopId, turnId, fromSequence } = args;
        const channels = await this.#db.engine_worker_stream_channels.all<{
            subscription_id: number; publication_id: number; published_end: number;
            runtime: string; authority: string; coord: string; channel: string; content: string;
            mimetype: string; state: string; producer_result: string | null; published_channel: string | null;
            default_channel: string;
        }>({ worker_id: workerId });
        const entryIds: number[] = [];
        // {§exec-stream} — a concluded stream lands one row per channel that has content; an empty
        // sibling channel is a fact on that row (`channels`), never a row of its own, and only a
        // stream that printed nothing at all lands one bodyless row on its default channel
        // (operator, 2026-09-13: the empty ambient row was a packet bomb).
        const closedBySubscription = new Map<number, typeof channels>();
        for (const ch of channels) {
            if (ch.state !== "closed" && ch.state !== "errored") continue;
            const group = closedBySubscription.get(ch.subscription_id) ?? [];
            group.push(ch);
            closedBySubscription.set(ch.subscription_id, group);
        }
        const skipped = new Set<number>();
        const siblings = new Map<number, Record<string, number>>();
        for (const group of closedBySubscription.values()) {
            const withContent = group.filter((ch) => ch.content.length > 0);
            const kept = withContent.length > 0 ? withContent : group.filter((ch) => ch.channel === ch.default_channel).slice(0, 1);
            if (kept.length === 0) kept.push(group[0]!);
            for (const ch of group) {
                if (kept.includes(ch)) continue;
                skipped.add(ch.publication_id);
                await this.#db.engine_mark_publication_terminal.run({ publication_id: ch.publication_id, published_end: ch.content.length });
            }
            const empties = Object.fromEntries(group.filter((ch) => !kept.includes(ch)).map((ch) => [`#${ch.channel}`, 0]));
            for (const ch of kept) siblings.set(ch.publication_id, empties);
        }
        for (const ch of channels) {
            // Default channels are an implementation detail. Preserve the
            // channel internally on the entry/subscription, but present the
            // ordinary address to the model; only an explicitly non-default
            // channel earns a fragment in the log.
            const visibleFragment = ch.published_channel !== null
                && ch.channel === ch.default_channel
                ? null
                : ch.channel;
            const targetParts = authorityParts(ch.authority);
            // {§exec-stream} — nothing publishes while a stream is active: the Delegation streams
            // section reports its size and growth ({§child-orientation}); the model READs any
            // range it wants. At close, ONE foisted READ that is exactly a markerless READ —
            // the first page, the extent, the terminal status and Problem — initially visible. {§exec-stream-page}
            if (ch.state !== "closed" && ch.state !== "errored") continue;
            if (skipped.has(ch.publication_id)) continue;
            const terminal = Results.assert(JSON.parse(ch.producer_result ?? "null") as SchemeResult);
            const sequence = fromSequence + entryIds.length;
            const page = await ReadResolve.resolve({ content: ch.content, mimetype: ch.mimetype, lineMarker: null });
            const emptySiblings = siblings.get(ch.publication_id) ?? {};
            const result = Results.assert({
                ...terminal,
                terminal: true,
                ...(terminal.problem === undefined ? {} : { problem: { ...terminal.problem } }),
                content: page.content ?? "",
                mimetype: page.mimetype,
                ...(Object.keys(emptySiblings).length === 0 ? {} : { channels: emptySiblings }),
                ...(page.startLine === undefined || page.startLine === null ? {} : { startLine: page.startLine }),
                ...(page.range === undefined ? {} : { range: page.range }),
                ...(page.range !== undefined || page.region === undefined ? {} : { region: page.region }),
            });
            if (result.problem !== undefined && result.problem.instance === undefined) {
                const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                    loop_id: loopId,
                    turn_id: turnId,
                });
                if (seqs === undefined) throw new Error(`stream delta has no log coordinate for loop=${loopId} turn=${turnId}`);
                Results.attachInstance(result, `log:///${seqs.loop_seq}/${seqs.turn_seq}/${sequence}/READ`);
            }
            const rx = JSON.stringify(result);
            const inserted = await this.#db.engine_insert_stream_delta.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                subscription_publication_id: ch.publication_id,
                scheme: ch.runtime, hostname: targetParts.hostname, port: targetParts.port,
                pathname: ch.coord, fragment: visibleFragment,
                rx,
                weight: LogBody.weight({
                    op: "READ",
                    attrs: {},
                    tx: "",
                    rx,
                    mimetypeTx: "text/plain",
                    mimetypeRx: "application/json",
                }, this.#weighContent),
                status: terminal.status,
                attrs: JSON.stringify({ streamEnd: ch.content.length }),
                folded: LogVisibility.serialize(LogVisibility.OPEN), // {§exec-stream} — the conclusion is initially visible
            });
            if (inserted === undefined) throw new Error(`stream publication ${ch.publication_id} produced no log row`);
            entryIds.push(inserted.id);
        }
        return entryIds;
    }


    // {§env-delta-filesystem-narration} {§membership-emi-divergence-signal}
    // — record project-file divergence once through the reserved actor.
    async logFsFictions(
        workspaceId: number,
        divergences: FsDivergence[],
        gitStatus: GitStatusSnapshot | null,
    ): Promise<void> {
        if (divergences.length === 0) return;
        const gitByPath = new Map(gitStatus?.files.map(({ path, status }) => [path, status] as const) ?? []);
        const workerId = await RuntimeWorker.ensure(this.#db, workspaceId);
        const loop = await this.#db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: workerId });
        if (loop === undefined) throw new Error("logFsFictions: loop insert returned no row");
        const turn = await Turn.open(this.#db, { loopId: loop.id, producer: "_plurnk", kind: "operation" });
        let turnOpen = true;
        try {
            let sequence = 1;
            for (const d of divergences) {
                const span = editedSpan(d.before, d.after);
                const rx = JSON.stringify({ status: 200, entryId: d.entryId, channel: d.channel, span });
                const attrs = gitByPath.has(d.pathname)
                    ? JSON.stringify({ git: gitByPath.get(d.pathname) })
                    : "{}";
                await this.#db.engine_insert_log_entry.get({
                    worker_id: workerId, loop_id: loop.id, turn_id: turn.id, sequence: sequence++,
                    origin: "_plurnk", source: "file", model_call_id: null,
                    op: "EDIT", signal: null,
                    // Match Dispatcher.#extractTarget: a bare file address has NULL scheme
                    // only in log target metadata; its entry identity remains `file`.
                    scheme: null, username: null, password: null, hostname: null, port: null,
                    pathname: d.pathname, query: null, fragment: null, lineMarker: null,
                    tx: "", mimetype_tx: "text/plain",
                    rx, mimetype_rx: "application/json",
                    status_rx: 200,
                    weight: LogBody.weight({
                        op: "EDIT",
                        attrs,
                        tx: "",
                        rx,
                        mimetypeTx: "text/plain",
                        mimetypeRx: "application/json",
                    }, this.#weighContent),
                    state: "resolved", outcome: null,
                    attrs,
                    initial_folded: LogVisibility.serialize(LogVisibility.OPEN),
                });
            }
            await Turn.complete(this.#db, turn.id, 200);
            turnOpen = false;
            const closed = await new LoopLifecycle(this.#db).finish(loop.id, { status: 200 });
            if (closed === null) throw new Error(`logFsFictions: narration loop ${loop.id} was not open at completion`);
        } catch (cause) {
            const settlementFailures: unknown[] = [];
            const failure = Results.failure(
                "engine:filesystem-narration",
                "narration-failed",
                500,
                "Filesystem divergence narration failed before its operation turn settled.",
                {},
                { stage: "filesystem-narration", retryable: false },
            );
            if (turnOpen) {
                try { await Turn.complete(this.#db, turn.id, failure.status); }
                catch (turnCause) { settlementFailures.push(turnCause); }
            }
            try { await new LoopLifecycle(this.#db).finish(loop.id, failure); }
            catch (loopCause) { settlementFailures.push(loopCause); }
            if (settlementFailures.length > 0) {
                throw new AggregateError([cause, ...settlementFailures], `filesystem narration ${turn.id} failed to settle`);
            }
            throw cause;
        }
    }



    // {§message-arrival} — an arrival is an inbound SEND row: the sender's statement as the row's
    // sent side, published by the harness (origin `_plurnk`) with the causal `source` when another
    // actor caused it ({§message-causal-source}). `attrs.kind = "message"` tells it from the
    // engine's other harness-published SEND rows: observed activity and addressed replies.
    async writeArrivalLog({
        workerId,
        loopId,
        turnId,
        sequence,
        body,
        source,
        resource,
        selfAddressed = false,
    }: {
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        body: string;
        source: string | null;
        resource: string;
        // {§message-short-identity} the source is the transport's own name for this message, so it
        // tells the model nothing its address does not; clients still read it from the row.
        selfAddressed?: boolean;
    }): Promise<number> {
        const tx = JSON.stringify({ op: "SEND", aside: null, target: null, metadata: null, lineMarker: null, matcher: null, body: { raw: body } });
        const rx = JSON.stringify({ status: 200, resource });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence,
            origin: "_plurnk",
            source,
            model_call_id: null,
            op: "SEND",
            signal: null,
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx,
            mimetype_tx: "application/json",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: LogBody.weight({
                op: "SEND",
                attrs: selfAddressed ? { kind: "message", selfAddressed: true } : { kind: "message" },
                tx,
                rx,
                mimetypeTx: "application/json",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved",
            outcome: null,
            attrs: JSON.stringify(selfAddressed ? { kind: "message", selfAddressed: true } : { kind: "message" }),
            initial_folded: LogVisibility.serialize(LogVisibility.OPEN),
        });
        if (row === undefined) throw new Error("TurnMaterialization.writeArrivalLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // External API to feed a resolution into a pending proposal — the client-interface
    // seam, core-owned disposition, or the timeout watcher.
    // {§worker-lifecycle-total-reap}: release every stopped-world waiter before joining drains.
}
