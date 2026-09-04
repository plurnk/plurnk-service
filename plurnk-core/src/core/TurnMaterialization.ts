// The durable writes a turn makes beside its packet: environment and stream deltas, filesystem fictions, the prompt log. Split out of TurnRunner.
import type { UrlPath } from "@plurnk/plurnk-contracts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import { type FsDivergence } from "./git-membership.ts";
import { type GitStatusSnapshot } from "./git-state.ts";
import { editedSpan } from "../content/index.ts";
import ReadResolve from "../content/read-resolve.ts";
import { authorityParts } from "./plurnk-uri.ts";
import Results, { type SchemeResult } from "./results.ts";
import TerminalResult from "./TerminalResult.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Turn from "./Turn.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";

export default class TurnMaterialization {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #weighContent: (text: string) => number;

    constructor({ db, schemes, weighContent }: {
        db: Db;
        schemes: SchemeRegistry;
        weighContent: (text: string) => number;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#weighContent = weighContent;
    }

    async materializeEnvironmentDeltas(args: {
        workspaceId: number; workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { workspaceId, workerId, loopId, turnId, fromSequence } = args;
        const rows = await this.#db.engine_pull_ambient_events.all<{
            cursor: number;
            boundary: number;
            event_id: number | null;
            producer_worker_id: number | null;
            producer_worker_name: string | null;
            kind: "activity" | "loop_termination" | null;
            source: string | null;
            at: string | null;
            op: string | null;
            delimiter: string | null;
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
        let written = 0;
        for (const r of rows) {
            if (r.event_id === null || r.producer_worker_id === null || r.producer_worker_name === null || r.kind === null
                || r.at === null || r.op === null || r.delimiter === null || r.tx === null || r.mimetype_tx === null
                || r.rx === null || r.mimetype_rx === null || r.status_rx === null || r.state === null) continue;
            const termination = r.kind === "loop_termination";
            const terminal = termination
                ? TerminalResult.parse(r.rx, `ambient loop-termination event ${r.event_id}`)
                : null;
            if (terminal !== null && terminal.status !== r.status_rx) {
                throw new Error(`ambient loop-termination event ${r.event_id} status ${r.status_rx} does not match its terminal result status ${terminal.status}`);
            }
            let attrs = r.attrs ?? "{}";
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
            }
            const inserted = await this.#db.engine_insert_ambient_delta.get<{ id: number }>({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence: fromSequence + written,
                at: r.at,
                event_id: r.event_id,
                source: WorkerControlAddress.render(r.producer_worker_name),
                op: r.op,
                delimiter: r.delimiter,
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
                rx: r.rx,
                mimetype_rx: r.mimetype_rx,
                status: r.status_rx,
                weight: LogBody.weight({
                    op: r.op,
                    attrs,
                    tx: r.tx,
                    rx: r.rx,
                    mimetypeTx: r.mimetype_tx,
                    mimetypeRx: r.mimetype_rx,
                }, this.#weighContent),
                state: r.state,
                outcome: r.outcome,
                folded: LogVisibility.serialize(
                    terminal !== null && terminal.status >= 200 && terminal.status < 300
                        ? LogVisibility.OPEN
                        : LogVisibility.FOLDED,
                ),
                attrs,
            });
            const materialized = inserted ?? await this.#db.engine_ambient_delta_id.get<{ id: number }>({
                worker_id: workerId,
                event_id: r.event_id,
            });
            if (materialized === undefined) throw new Error(`ambient event ${r.event_id} has no observer log row after materialization`);
            if (inserted !== undefined) written++;
        }
        await this.#db.engine_advance_ambient_cursor.get({
            workspace_id: workspaceId,
            worker_id: workerId,
            cursor: window.cursor,
            boundary: window.boundary,
        });
        return written;
    }


    async materializeStreamDeltas(args: {
        workerId: number; loopId: number; turnId: number; fromSequence: number;
    }): Promise<number> {
        const { workerId, loopId, turnId, fromSequence } = args;
        const channels = await this.#db.engine_worker_stream_channels.all<{
            subscription_id: number; publication_id: number; published_end: number;
            runtime: string; authority: string; coord: string; channel: string; content: string;
            mimetype: string; state: string; producer_result: string | null; published_channel: string | null;
        }>({ worker_id: workerId });
        let written = 0;
        for (const ch of channels) {
            // Default channels are an implementation detail. Preserve the
            // channel internally on the entry/subscription, but present the
            // ordinary address to the model; only an explicitly non-default
            // channel earns a fragment in the log.
            const visibleFragment = ch.published_channel !== null
                && ch.channel === this.#schemes.defaultChannelFor(ch.runtime, workerId)
                ? null
                : ch.channel;
            const targetParts = authorityParts(ch.authority);
            // {§exec-stream} — nothing publishes while a stream is active: the Child Streams
            // section reports its size and growth ({§child-orientation}); the model READs any
            // range it wants. At close, ONE foisted READ that is exactly a markerless READ —
            // the first page, the extent, the terminal status and Problem — born OPEN. {§exec-stream-page}
            if (ch.state !== "closed" && ch.state !== "errored") continue;
            const terminal = Results.assert(JSON.parse(ch.producer_result ?? "null") as SchemeResult);
            const sequence = fromSequence + written;
            // {§log-coordinate-hierarchy} — the stream lives at its EXEC item's own address, so the
            // causal source is that address under the log scheme.
            const source = this.#schemes.isRuntimeScheme(ch.runtime, workerId)
                && /^\/[1-9]\d*\/[1-9]\d*\/[1-9]\d*\/EXEC$/.test(ch.coord)
                ? `log://${ch.coord}`
                : null;
            const page = await ReadResolve.resolve({ content: ch.content, mimetype: ch.mimetype, lineMarker: null });
            const result = Results.assert({
                ...terminal,
                ...(terminal.problem === undefined ? {} : { problem: { ...terminal.problem } }),
                content: page.content ?? "",
                mimetype: page.mimetype,
                ...(page.startLine === undefined || page.startLine === null ? {} : { startLine: page.startLine }),
                ...(page.range === undefined ? {} : { range: page.range }),
            });
            if (result.problem !== undefined) {
                const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                    loop_id: loopId,
                    turn_id: turnId,
                });
                if (seqs === undefined) throw new Error(`stream delta has no log coordinate for loop=${loopId} turn=${turnId}`);
                Results.attachInstance(result, `log:///${seqs.loop_seq}/${seqs.turn_seq}/${sequence}/READ`);
            }
            const rx = JSON.stringify(result);
            await this.#db.engine_insert_stream_delta.run({
                worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
                subscription_publication_id: ch.publication_id,
                source,
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
                attrs: JSON.stringify({ streamEnd: ch.content.length, terminal: true }),
                folded: LogVisibility.serialize(LogVisibility.OPEN), // {§exec-stream} — the conclusion is born OPEN
            });
            written++;
        }
        return written;
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
        const worker = await this.#db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk" })
            ?? await this.#db.envelope_insert_worker.get<{ id: number }>({ workspace_id: workspaceId, name: "plurnk", origin: "_plurnk" });
        if (worker === undefined) throw new Error("logFsFictions: plurnk worker resolution returned no row");
        const loop = await this.#db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: worker.id });
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
                    worker_id: worker.id, loop_id: loop.id, turn_id: turn.id, sequence: sequence++,
                    origin: "_plurnk", source: "file", model_call_id: null,
                    op: "EDIT", delimiter: "", signal: null,
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



    async writePromptLog({
        workerId,
        loopId,
        turnId,
        sequence,
        target,
        content,
        source,
    }: {
        workerId: number;
        loopId: number;
        turnId: number;
        sequence: number;
        target: UrlPath;
        content: string;
        source: string | null;
    }): Promise<number> {
        const rx = JSON.stringify({ content, mimetype: "text/markdown" });
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence,
            origin: "_plurnk",
            source,
            model_call_id: null,
            op: "prompt",
            delimiter: "",
            signal: null,
            scheme: target.scheme,
            username: target.username,
            password: target.password,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            query: target.query,
            fragment: target.fragment,
            lineMarker: null,
            tx: "",
            mimetype_tx: "text/plain",
            rx,
            mimetype_rx: "application/json",
            status_rx: 200,
            weight: LogBody.weight({
                op: "prompt",
                attrs: {},
                tx: "",
                rx,
                mimetypeTx: "text/plain",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved",
            outcome: null,
            attrs: "{}",
            initial_folded: LogVisibility.serialize(LogVisibility.OPEN),
        });
        if (row === undefined) throw new Error("TurnRunner.#writePromptLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // External API to feed a resolution into a pending proposal — the client-interface
    // seam, core-owned disposition, or the timeout watcher.
    // {§worker-lifecycle-total-reap}: release every stopped-world waiter before joining drains.
}
