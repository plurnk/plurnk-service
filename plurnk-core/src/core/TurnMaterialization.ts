// The durable writes a turn makes beside its packet: environment and stream deltas, filesystem fictions, message arrivals. Split out of TurnRunner.
import type { Db } from "./Db.ts";
import { type FsDivergence } from "./git-membership.ts";
import { type GitStatusSnapshot } from "./git-state.ts";
import { editedSpan } from "../content/index.ts";
import ReadResolve from "../content/read-resolve.ts";
import ReadProjector from "../content/read-projector.ts";
import TurnSource from "../schemes/TurnSource.ts";
import { loopOutcome } from "./LoopOutcome.ts";
import { authorityParts } from "./plurnk-uri.ts";
import Results, { type SchemeResult } from "./results.ts";
import TerminalResult from "./TerminalResult.ts";
import LoopLifecycle from "./LoopLifecycle.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import Turn from "./Turn.ts";
import AdministrativeLoop from "./AdministrativeLoop.ts";
import RuntimeWorker from "./RuntimeWorker.ts";
import LogBody from "./LogBody.ts";
import LogVisibility from "./LogVisibility.ts";
import { TextCoordinates, type Mimetypes } from "@plurnk/plurnk-mimetypes";
import PacketWire, { type StoredLogRow } from "./packet-wire.ts";
import { reserved, resultSize, unfitResult, type ContextFit } from "./ContextFit.ts";

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
                // {§loop-answer} the row IS what the child said, at the child's own loop address.
                const sequence = Number(r.pathname?.slice(1) ?? "0");
                const outcome = r.hostname === null || !Number.isSafeInteger(sequence)
                    ? null
                    : await loopOutcome(this.#db, workspaceId, r.hostname, sequence);
                const resource = outcome?.resource ?? `ops://${r.hostname}${r.pathname}`;
                rx = JSON.stringify(await ReadProjector.project({
                    statement: { op: "READ", target: null, lineMarker: null, matcher: null, metadata: null,
                        body: null, aside: null, position: { line: 1, column: 1 } },
                    manifest: TurnSource.manifestFor("ops"), publishesLineAnchors: false,
                    target: resource, identity: resource, mimetypes: this.#mimetypes,
                    representation: TerminalResult.representation(outcome?.result ?? terminal, resource, r.terminated_by),
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
        // {§context-fit} — a closed stream's result is one the model asked for: whole when it fits, else its size.
        fit?: ContextFit;
    }): Promise<number[]> {
        const { workspaceId, workerId, loopId, turnId, fromSequence, fit } = args;
        const channels = await this.#db.engine_worker_stream_channels.all<{
            subscription_id: number; publication_id: number; published_end: number;
            runtime: string; authority: string; coord: string; channel: string; content: string;
            mimetype: string; state: string; producer_result: string | null; published_channel: string | null;
            default_channel: string;
        }>({ worker_id: workerId });
        const entryIds: number[] = [];
        // {§exec-stream} — a concluded stream lands one row per channel that has content; an empty
        // sibling channel is a fact on that row (`channels`), never a row of its own, and only a
        // stream that printed nothing at all lands one bodyless row on its default channel.
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
        // {§context-fit} — the rows this pass lands, known before the first one is measured.
        const landing = channels.filter((ch) => (ch.state === "closed" || ch.state === "errored")
            && ch.producer_result !== null && !skipped.has(ch.publication_id));
        for (const [index, ch] of landing.entries()) {
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
            // range it wants. At close, ONE foisted READ that is exactly a markerless READ — the first
            // page ({§markerless-first-page}, {§exec-stream-page}), whole when it fits the budget and
            // otherwise its size ({§context-fit}) — with the extent, the terminal status and Problem,
            // initially visible.
            // {§stream-observation-result} — the terminal result lands in a separate write after
            // the executor closes the channel (#818); `landing` holds only channels that have one.
            // {§validation-topology}: a stored result is chapter 5's; it is parsed, not re-asserted.
            const terminal = JSON.parse(ch.producer_result!) as SchemeResult;
            const sequence = fromSequence + entryIds.length;
            const page = await ReadResolve.resolve({ content: ch.content, mimetype: ch.mimetype, lineMarker: null });
            const emptySiblings = siblings.get(ch.publication_id) ?? {};
            const whole = Results.assert({
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
            const streamRow = (rendered: SchemeResult): StoredLogRow => ({
                id: null, loop_seq: 0, turn_seq: 0, sequence, origin: "_plurnk", op: "READ", signal: null,
                scheme: ch.runtime, username: null, password: null, hostname: targetParts.hostname, port: targetParts.port,
                pathname: ch.coord, query: null, fragment: visibleFragment,
                status_rx: rendered.status, rx: JSON.stringify(rendered), mimetype_rx: "application/json",
                tx: "", mimetype_tx: "text/plain",
                initial_folded: LogVisibility.serialize(LogVisibility.OPEN), folded: LogVisibility.serialize(LogVisibility.OPEN),
                source: null, attrs: JSON.stringify({ streamEnd: ch.content.length }), producer: "_plurnk",
            });
            const unfit = await this.#unfit(workspaceId, loopId, turnId, fit === undefined ? undefined : reserved(fit, landing.length - index - 1), whole.content, () => streamRow(whole));
            // {§context-fit} — too large for the remaining budget: the terminal's own status and Problem stay
            // when the stream failed; a clean close becomes the 413 receipt. The output remains at the stream.
            const result = unfit === null ? whole : Results.assert(terminal.status >= 400 && terminal.problem !== undefined
                ? { ...whole, content: "", problem: { ...terminal.problem, ...unfit.facts } }
                : unfitResult({
                    terminal: true, mimetype: page.mimetype,
                    ...(Object.keys(emptySiblings).length === 0 ? {} : { channels: emptySiblings }),
                    ...(page.range === undefined ? {} : { range: page.range }),
                }, resultSize(page), unfit.tokens, unfit.remaining));
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


    // {§context-fit} — whether one row to be landed fits the remaining budget: null when it fits or no
    // budget exists; otherwise its tokens, the remaining budget, and the facts a receipt names.
    async #unfit(
        workspaceId: number,
        loopId: number,
        turnId: number,
        fit: ContextFit | undefined,
        content: string | null | undefined,
        row: (seqs: { loop_seq: number; turn_seq: number }) => StoredLogRow,
    ): Promise<{ tokens: number; remaining: number; facts: Record<string, number> } | null> {
        if (fit === undefined || typeof content !== "string" || content.length === 0) return null;
        const remaining = await fit.remaining();
        if (remaining === null) return null;
        const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({ loop_id: loopId, turn_id: turnId });
        if (seqs === undefined) throw new Error(`TurnMaterialization: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
        const workspace = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const built = row(seqs);
        const tokens = PacketWire.rowTokens(
            PacketWire.entryView({ ...built, loop_seq: seqs.loop_seq, turn_seq: seqs.turn_seq }),
            this.#weighContent,
            { projectRoot: workspace?.project_root ?? null },
        );
        if (tokens <= remaining) return null;
        return { tokens, remaining, facts: { lines: TextCoordinates.logicalLines(content).length, tokens, remaining } };
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
        const loop = await AdministrativeLoop.open(this.#db, workerId, "runtime");
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
        workspaceId,
        workerId,
        loopId,
        turnId,
        sequence,
        body,
        source,
        resource,
        selfAddressed = false,
        fit,
    }: {
        workspaceId: number;
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
        // {§context-fit} — an arrival the model did not ask for lands whole when it fits, otherwise folded
        // with its size beside it: a fact, not an error; its body stays READable at the row.
        fit?: ContextFit;
    }): Promise<number> {
        const tx = JSON.stringify({ op: "SEND", aside: null, target: null, metadata: null, lineMarker: null, matcher: null, body: { raw: body } });
        const rx = JSON.stringify({ status: 200, resource });
        const baseAttrs: Record<string, unknown> = selfAddressed ? { kind: "message", selfAddressed: true } : { kind: "message" };
        const unfit = await this.#unfit(workspaceId, loopId, turnId, fit, body, (seqs) => ({
            id: null, loop_seq: seqs.loop_seq, turn_seq: seqs.turn_seq, sequence, origin: "_plurnk", op: "SEND", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, query: null, fragment: null,
            status_rx: 200, rx, mimetype_rx: "application/json", tx, mimetype_tx: "application/json",
            initial_folded: LogVisibility.serialize(LogVisibility.OPEN), folded: LogVisibility.serialize(LogVisibility.OPEN),
            source, attrs: JSON.stringify(baseAttrs), producer: "model",
        }));
        const attrs = unfit === null ? baseAttrs : { ...baseAttrs, unfit: { lines: unfit.facts.lines, tokens: unfit.tokens } };
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
                attrs,
                tx,
                rx,
                mimetypeTx: "application/json",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "resolved",
            outcome: null,
            attrs: JSON.stringify(attrs),
            initial_folded: LogVisibility.serialize(unfit === null ? LogVisibility.OPEN : LogVisibility.FOLDED),
        });
        if (row === undefined) throw new Error("TurnMaterialization.writeArrivalLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // External API to feed a resolution into a pending proposal — the client-interface
    // seam, core-owned disposition, or the timeout watcher.
    // {§worker-lifecycle-total-reap}: release every stopped-world waiter before joining drains.
}
