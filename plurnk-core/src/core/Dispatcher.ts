import { parsePath } from "@plurnk/plurnk-grammar";
import type { PlurnkStatement, ParsedPath, LineMarker, PlurnkOp, ReadStatement, EditStatement } from "@plurnk/plurnk-grammar";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import Owner from "./Owner.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type TelemetryChannel from "./TelemetryChannel.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type { ProposalPendingEvent } from "./ProposalLifecycle.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { foldAuthorityIntoPath, schemeNameOf } from "./plurnk-uri.ts";
import Fork from "./fork.ts";
import WorkerCap from "./worker-cap.ts";
import { decodePathParens } from "./path-decode.ts";
import Namespace from "./namespace.ts";
import type { SchemeManifest, WriterTier, PlurnkSchemeContext, LoopFlags } from "./scheme-types.ts";
import { DEFAULT_LOOP_FLAGS } from "./scheme-types.ts";
import ChannelWrite, { type StreamEventNotify, type WakeWorkerNotify, type InjectWorkerNotify, type CancelWorkerNotify, type CancelDescendantsNotify } from "./ChannelWrite.ts";
import { LineMarkerOps, MimetypeBinary } from "../content/index.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import EntryFind from "../schemes/_entry-find.ts";
import EntryOps from "../schemes/_entry-ops.ts";
import WorkspaceSettings from "./workspace-settings.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import LoopLifecycle from "./LoopLifecycle.ts";

// SPEC §scheme-surface: writer must be in target scheme's manifest.writableBy.
// OPEN/FOLD/READ/FIND are not gated — they curate the log or read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "EXEC", "KILL", "FORK", "WORK"]);

const pathnameFromPath = (path: ParsedPath): string => {
    if (path.kind === "regex") return path.raw; // regex source — parens are syntax, never encoded
    return decodePathParens(path.kind === "url" ? path.pathname : path.raw); // #239 item 4
};

export type DispatchContext = {
    statement: PlurnkStatement;
    workspaceId: number;
    workerId: number;
    loopId: number;
    turnId: number;
    sequence: number;
    origin: WriterTier;
    onDispatch?: (logEntryId: number) => void;
    // §send-200-failed-ops — this emission's parse-error count, threaded from runTurn (parse errors
    // mint AFTER dispatch, so the terminal gate can't see them as rows). Absent off-run.
    turnParseErrors?: number;
};

export type DispatchResult = { status: number; attrs?: object; [key: string]: unknown };

import type { SchemeCtx, SchemeHandler } from "@plurnk/plurnk-schemes";
type SchemeMethod = (statement: PlurnkStatement, ctx: SchemeCtx) => Promise<DispatchResult>;
type PreparedEdit = {
    readonly first: boolean;
    readonly index: number;
    readonly initial: DispatchResult;
    readonly settled: Promise<DispatchResult>;
    settle(result: DispatchResult): void;
};

interface SchemeWithCrud {
    readEntry?: (pathname: string, ctx: SchemeCtx) => Promise<ReadEntryResult>;
    writeEntry?: (pathname: string, entry: EntryData, ctx: SchemeCtx) => Promise<WriteEntryResult>;
    deleteEntry?: (pathname: string, ctx: SchemeCtx) => Promise<DeleteEntryResult>;
}

// Op dispatch (§op-methods-op-dispatch): gates (writableBy, loop flags), the
// engine-owned op orchestrations (COPY/MOVE/KILL/SEND/READ-fanout), scheme
// routing, the durable log write, and the proposal pause.
export default class Dispatcher {
    #db: Db;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #tokenize: (text: string) => number;
    #telemetry: TelemetryChannel;
    #proposals: ProposalLifecycle;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    #streamEventNotify: StreamEventNotify | undefined;
    #wakeWorkerNotify: WakeWorkerNotify | undefined;
    #injectWorker: InjectWorkerNotify | undefined;
    #cancelWorker: CancelWorkerNotify | undefined;
    #cancelDescendants: CancelDescendantsNotify | undefined;
    // §send-premature-terminate/[102]<T> — the engine-owned park-deadline registry (loopId → seconds;
    // -1 = indefinite). The dispatcher WRITES at park; the daemon's drain park-exit consumes.
    #parkDeadlines: Map<number, number>;
    readonly #searchGate: import("./search-gate.ts").default | undefined;
    // §join-blocking-collect (#354) — loops with a READ(worker://running-child) armed this turn; a bare
    // SEND[102] parks on it (blocking join). Engine-owned, twin of #parkDeadlines.
    #joinTargets: Set<number>;
    #liveSubscriptions: LiveSubscriptions;
    #lifecycle: LoopLifecycle;
    #preparedEdits = new WeakMap<EditStatement, PreparedEdit>();

    constructor({ db, schemes, mimetypes, tokenize, telemetry, proposals, executors, loopSignal, streamEventNotify, wakeWorkerNotify, injectWorker, cancelWorker, cancelDescendants, searchGate, parkDeadlines, joinTargets, liveSubscriptions }: {
        db: Db;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        tokenize: (text: string) => number;
        telemetry: TelemetryChannel;
        proposals: ProposalLifecycle;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        streamEventNotify?: StreamEventNotify;
        wakeWorkerNotify?: WakeWorkerNotify;
        injectWorker?: InjectWorkerNotify;
        cancelWorker?: CancelWorkerNotify;
        cancelDescendants?: CancelDescendantsNotify;
        parkDeadlines?: Map<number, number>;
        searchGate?: import("./search-gate.ts").default;
        joinTargets?: Set<number>;
        liveSubscriptions: LiveSubscriptions;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#tokenize = tokenize;
        this.#telemetry = telemetry;
        this.#proposals = proposals;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#streamEventNotify = streamEventNotify;
        this.#wakeWorkerNotify = wakeWorkerNotify;
        this.#injectWorker = injectWorker;
        this.#cancelWorker = cancelWorker;
        this.#cancelDescendants = cancelDescendants;
        this.#parkDeadlines = parkDeadlines ?? new Map();
        this.#searchGate = searchGate;
        this.#joinTargets = joinTargets ?? new Set();
        this.#liveSubscriptions = liveSubscriptions;
        this.#lifecycle = new LoopLifecycle(db);
    }

    // workspace → project_root, memoized: {§fs-namespace} fixes the root immutably at
    // workspace creation, so a process-lifetime cache can never go stale.
    #rootCache = new Map<number, string | null>();

    #handlerContext(scheme: string, ctx: PlurnkSchemeContext): SchemeCtxImpl | null {
        const manifest = this.#schemes.manifestFor(scheme);
        return manifest === undefined ? null : new SchemeCtxImpl(ctx, scheme, manifest, this.#liveSubscriptions);
    }

    #entryContext(scheme: string, ctx: PlurnkSchemeContext): SchemeCtxImpl | null {
        const handlerCtx = this.#handlerContext(scheme, ctx);
        return this.#schemes.manifestFor(scheme)?.category === "data" ? handlerCtx : null;
    }

    async #readEntry(scheme: string, pathname: string, ctx: PlurnkSchemeContext): Promise<ReadEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.readEntry === "function" && handlerCtx !== null) return handler.readEntry(pathname, handlerCtx);
        const caps = handlerCtx?.entries;
        if (caps === undefined) return { status: 501, entry: null };
        const result = await caps.read(pathname, scheme === "prompt" ? "worker" : "commons");
        return {
            status: result.status,
            entry: result.entry === null
                ? null
                : { channels: { ...result.entry.channels }, tags: [...result.entry.tags] },
        };
    }

    async #writeEntry(scheme: string, pathname: string, entry: EntryData, ctx: PlurnkSchemeContext): Promise<WriteEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.writeEntry === "function" && handlerCtx !== null) return handler.writeEntry(pathname, entry, handlerCtx);
        const caps = handlerCtx?.entries;
        if (caps === undefined) return { status: 501, created: false, entryId: null };
        return caps.write(pathname, entry);
    }

    async #deleteEntry(scheme: string, pathname: string, ctx: PlurnkSchemeContext): Promise<DeleteEntryResult> {
        const handler = this.#schemes.get(scheme) as SchemeWithCrud | undefined;
        const handlerCtx = this.#entryContext(scheme, ctx);
        if (typeof handler?.deleteEntry === "function" && handlerCtx !== null) return handler.deleteEntry(pathname, handlerCtx);
        const caps = handlerCtx?.entries;
        return caps === undefined ? { status: 501 } : caps.delete(pathname);
    }
    async #workspaceRoot(workspaceId: number): Promise<string | null> {
        if (this.#rootCache.has(workspaceId)) return this.#rootCache.get(workspaceId) ?? null;
        const row = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const root = row?.project_root ?? null;
        this.#rootCache.set(workspaceId, root);
        return root;
    }

    // {§fs-answer-in-canon} — a file-class target's engine-authored address COLUMNS carry
    // the canonical key; the tx JSON keeps the model's verbatim statement (history is never
    // rewritten — the one surviving spelling). An un-canonicalizable spelling keeps its raw
    // form: the row must still faithfully exist for the op that happened.
    async #canonColumns(target: { scheme: string | null; pathname: string | null }, workspaceId: number): Promise<void> {
        if (target.scheme !== null || target.pathname === null) return;
        const key = Namespace.canonicalizeSpelling(target.pathname, await this.#workspaceRoot(workspaceId));
        if (key !== null) target.pathname = key;
    }

    async prepareEditBatches(statements: readonly EditStatement[], context: Omit<DispatchContext, "statement" | "sequence">): Promise<void> {
        const { workspaceId, workerId, loopId, turnId, origin } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId, origin });
        const groups = new Map<string, EditStatement[]>();
        for (const statement of statements) {
            const target = this.#extractTarget(statement.target);
            await this.#canonColumns(target, workspaceId);
            const key = JSON.stringify([
                schemeNameOf(statement.target),
                target.scheme,
                target.hostname,
                target.pathname,
                target.fragment,
            ]);
            const group = groups.get(key);
            if (group === undefined) groups.set(key, [statement]);
            else group.push(statement);
        }
        for (const group of groups.values()) {
            const first = group[0];
            const schemeName = schemeNameOf(first.target);
            let initial: DispatchResult;
            let denial = group.map((statement) => this.#checkWritable(statement, origin)).find((result) => result !== null) ?? null;
            if (denial === null) {
                for (const statement of group) {
                    denial = await this.#checkFlagsGate(statement, loopId);
                    if (denial !== null) break;
                }
            }
            if (denial !== null) {
                initial = denial;
            } else if (schemeName === null) {
                initial = { status: 400 };
            } else {
                const handler = this.#schemes.get(schemeName) as SchemeHandler | undefined;
                const method = handler?.editBatch;
                const manifest = this.#schemes.manifestFor(schemeName);
                if (typeof method !== "function" || manifest === undefined) {
                    initial = { status: 501 };
                } else {
                    try {
                        const addressedScheme = first.target?.kind === "url" ? first.target.scheme : schemeName;
                        initial = await method.call(handler, group, new SchemeCtxImpl(schemeCtx, addressedScheme ?? schemeName, manifest, this.#liveSubscriptions));
                    } catch (err) {
                        initial = { status: 500, error: err instanceof Error ? err.message : String(err) };
                    }
                }
            }
            let resolveSettled!: (result: DispatchResult) => void;
            const settled = new Promise<DispatchResult>((resolve) => { resolveSettled = resolve; });
            const prepared: PreparedEdit = {
                first: true,
                index: 0,
                initial,
                settled,
                settle: resolveSettled,
            };
            this.#preparedEdits.set(first, prepared);
            for (const [index, statement] of group.slice(1).entries()) {
                this.#preparedEdits.set(statement, { ...prepared, first: false, index: index + 1 });
            }
        }
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        const result = await this.#dispatchOne(context);
        if (context.statement.op === "EDIT") {
            const prepared = this.#preparedEdits.get(context.statement);
            if (prepared?.first === true) prepared.settle(result);
        }
        return result;
    }

    async #dispatchOne(context: DispatchContext): Promise<DispatchResult> {
        const { statement, workspaceId, workerId, loopId, turnId, sequence, origin, onDispatch, turnParseErrors } = context;
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId, origin });
        let result: DispatchResult;
        let denial = this.#checkWritable(statement, origin);
        if (denial === null) denial = await this.#checkFlagsGate(statement, loopId);
        if (denial !== null) {
            result = denial;
        } else if (this.#readFansOut(statement)) {
            // READ honors FIND: a glob/folder scope or a matcher fans out to one log row per MATCH
            // (its own writeLogs), returning early. A READ never proposes, so it bypasses the
            // single-row path below. A bare entry, body-less, falls through to the direct read. #286
            return await this.#handleReadFanout(statement, schemeCtx, { workerId, loopId, turnId, sequence, origin, onDispatch });
        } else {
            // SPEC §scheme-surface + plurnk-schemes#1: action-entry-as-outcome. Scheme-handler
            // exceptions become the action-entry's outcome (status 500), not a
            // thrown bubble. The log_entry is the durable record; engine never
            // skips it. Logging failures (#writeLog throws) are NOT caught —
            // those are system failures.
            try {
                if (statement.op === "EDIT") {
                    const prepared = this.#preparedEdits.get(statement);
                    if (prepared === undefined) {
                        result = { status: 500, error: "EDIT reached dispatch without a prepared resource batch" };
                    } else {
                        const settled = prepared.first ? prepared.initial : await prepared.settled;
                        const aggregate = settled.editReceipt ?? prepared.initial.editReceipt;
                        if (aggregate !== null && typeof aggregate === "object") {
                            const receipt = aggregate as {
                                revision: string;
                                unit: "lines" | "items";
                                before: number;
                                after: number;
                                effects: readonly object[];
                            };
                            const effect = receipt.effects[prepared.index];
                            if (effect === undefined) throw new Error(`EDIT receipt has no effect at index ${prepared.index}`);
                            const { editReceipt: _editReceipt, ...withoutAggregate } = settled;
                            result = {
                                ...withoutAggregate,
                                receipt: {
                                    revision: receipt.revision,
                                    unit: receipt.unit,
                                    before: receipt.before,
                                    after: receipt.after,
                                    effect,
                                },
                            };
                        } else {
                            result = settled;
                        }
                    }
                } else if (statement.op === "SEND" && statement.target === null) {
                    result = await this.#handleSendBroadcast(statement, { workspaceId, workerId, loopId, turnId, turnParseErrors });
                } else if (statement.op === "FORK" || statement.op === "WORK") {
                    result = await this.#handleWorkerControl(statement, schemeCtx);
                } else if (statement.op === "COPY") {
                    result = await this.#handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL") {
                    result = await this.#handleKill(statement, schemeCtx);
                } else if (statement.op === "PLAN") {
                    result = this.#handlePlan(statement);
                } else if (statement.op === "EXEC") {
                    // EXEC's target slot is `cwd`, not a scheme address.
                    // Per plurnk.md the op routes unconditionally to the
                    // exec scheme; the scheme handler reads runtime
                    // (signal), cwd (target), and command (body).
                    result = await this.#gatedExec(statement, schemeCtx, loopId, turnId);
                } else {
                    result = await this.#run(schemeNameOf(statement.target), statement, schemeCtx); // §op-methods-op-dispatch
                }
            } catch (err) { // a scheme exception becomes the op's 500 outcome — §scheme-surface-exception-500
                result = {
                    status: 500,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
        // §fold-open-meta-operations — OPEN/FOLD are render directives, not actions. They ARE
        // recorded (#382 — a curation act with no forensic trace is how run43's task-frame fold
        // stayed invisible), but engine_render_log suppresses them from the packet, so the receipt
        // rents zero model-facing space — the original clutter concern, resolved by hide-not-drop.
        // §join-blocking-collect (#354) — Run.read on a still-running child returns an awaitWorker signal;
        // arm the join so THIS turn's bare SEND[102] parks (the blocking collect) instead of spinning.
        if (typeof (result as { awaitWorker?: unknown }).awaitWorker === "string") this.#joinTargets.add(loopId);
        const logEntryId = await this.#writeLog({ statement, result, workspaceId, workerId, loopId, turnId, sequence, origin });
        // §search-gate — register successful searches AFTER #writeLog stamps the runtime
        // entry's coordinate onto result.attrs.pathname (the gate's dedup serves from it).
        if (statement.op === "EXEC" && result.status < 400) {
            const rt = ("signal" in statement && typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
            const cmd = ("body" in statement && typeof statement.body === "string") ? statement.body : "";
            const attrPath = (result.attrs as { pathname?: string } | undefined)?.pathname;
            if (typeof attrPath === "string") this.#searchGate?.registerPending(loopId, turnId, rt, cmd, attrPath);
        }
        onDispatch?.(logEntryId);
        // Proposal lifecycle (SPEC.md §engine-rails + §methods loop.resolve; §proposal-202-pauses). When a
        // side-effecting op returns status 202 (a broadcast SEND[202] park is model
        // speech, not a proposal — #isProposal, #255), the entry is written
        // state='proposed'; dispatch then PAUSES on a per-entry waiter until
        // resolution arrives via Engine.resolveProposal (from the loop/resolve RPC,
        // auto listener, or timeout). The post-resolution status replaces 202 in the
        // result the caller sees, so runTurn never branches on a pending state.
        if (Dispatcher.#isProposal(statement, result)) {
            // Effect-gated auto-run (read/pure runtimes, plurnk-service#182):
            // no human gate, no loop/proposal notification. Accept + apply
            // in-process; the model sees the outcome directly, never a review.
            if ((result.attrs as { inline?: boolean } | undefined)?.inline === true) {
                const effective = await this.#proposals.workerApply(statement, result, { decision: "accept" }, { workspaceId, workerId, loopId, turnId });
                return this.#proposals.applyResolution(logEntryId, effective);
            }
            // Register the resolution waiter SYNCHRONOUSLY before any await
            // yields. A same-tick resolveProposal() (e.g. from a test that
            // awaits the onDispatch callback and immediately resolves) must
            // find the waiter registered — adding an await between insert
            // and waiter-registration would open a race window.
            const resolutionPromise = this.#proposals.awaitResolution(logEntryId);
            // Notify external listeners (Daemon broadcasts loop/proposal;
            // auto listener auto-resolves) BEFORE awaiting — they may
            // resolve synchronously inside their handlers.
            const target = this.#extractTarget(statement.target);
            await this.#canonColumns(target, workspaceId); // {§fs-answer-in-canon} — compare in the same canon the rows store
            const flags = await this.#loadLoopFlags(loopId); // the proposal carries loop authority — §proposal-ownership-notification
            // #note10 — if the target diverged on disk this turn, the model's EDIT is based
            // on a stale read; flag it so a auto resolution rejects instead of clobbering.
            const diverged = await this.#db.engine_target_diverged_this_turn.get<{ hit: number }>({ worker_id: workerId, turn_id: turnId, scheme: target.scheme, pathname: target.pathname });
            const event: ProposalPendingEvent = {
                logEntryId, workspaceId, workerId, loopId, turnId,
                op: statement.op,
                target: { scheme: target.scheme, pathname: target.pathname },
                body: typeof result.body === "string" ? result.body : "",
                attrs: (result.attrs ?? {}) as object,
                flags,
                staleClobberRisk: diverged !== undefined,
            };
            this.#proposals.notifyPending(event);
            const resolution = await resolutionPromise;
            // Run the scheme's applyResolution hook on accept (writes the
            // file, spawns the process, etc.). If applyResolution returns a
            // 4xx/5xx or throws, the resolution is downgraded to a reject
            // with the failure outcome — engine treats it like a client
            // rejection.
            const effective = await this.#proposals.workerApply(statement, result, resolution, { workspaceId, workerId, loopId, turnId });
            // MOVE into a proposed dest: the deferred source-delete fires ONLY now,
            // after the dest write landed (accept). On reject the source survives.
            if (effective.decision === "accept") {
                const moveSource = (result.attrs as { moveSource?: { scheme: string; pathname: string } } | undefined)?.moveSource;
                if (moveSource !== undefined) {
                    const srcHandler = this.#schemes.get(moveSource.scheme) as (SchemeWithCrud & { applyResolution?: (a: { attrs: object }, c: SchemeCtx) => Promise<{ status: number }> }) | undefined;
                    if (srcHandler !== undefined) {
                        const del = await this.#deleteEntry(moveSource.scheme, moveSource.pathname, schemeCtx);
                        // A host-effecting source-delete PROPOSES (202); the MOVE proposal already gated the whole
                        // create+kill, so apply the source-delete now — never raise a second review for one MOVE.
                        const sourceCtx = this.#handlerContext(moveSource.scheme, schemeCtx);
                        if (del.status === 202 && del.attrs !== undefined && typeof srcHandler.applyResolution === "function" && sourceCtx !== null) await srcHandler.applyResolution({ attrs: del.attrs }, sourceCtx);
                    }
                }
            }
            const post = await this.#proposals.applyResolution(logEntryId, effective);
            return post;
        }
        return result;
    }

    // op.look (#283) — resolve a READ and return its content WITHOUT writing a
    // log_entries row: the client's off-run inspection primitive (LOOK → READ,
    // invisible to the model). READ never mutates and never proposes, so this is
    // dispatch's resolve path minus #writeLog. Runs on the client loop, so the
    // human's inspection is never constrained by a model loop's flags. {§op-look}
    async look(context: {
        statement: PlurnkStatement;
        workspaceId: number; workerId: number; loopId: number;
        origin?: WriterTier;
    }): Promise<DispatchResult> {
        const { statement, workspaceId, workerId, loopId, origin = "client" } = context;
        if (statement.op !== "READ") throw new Error(`look resolves READ only; got ${statement.op}`);
        // turnId is a write-time FK only — a look writes no row, so 0 (no turn) is inert.
        const schemeCtx = this.#buildSchemeCtx({ workspaceId, workerId, loopId, turnId: 0, origin });
        const denial = await this.#checkFlagsGate(statement, loopId);
        if (denial !== null) return denial;
        return this.#run(schemeNameOf(statement.target), statement, schemeCtx);
    }

    #buildSchemeCtx(ids: { workspaceId: number; workerId: number; loopId: number; turnId: number; origin: WriterTier }): PlurnkSchemeContext {
        const { workspaceId, workerId, loopId, turnId, origin } = ids;
        return {
            db: this.#db,
            workspaceId, workerId, loopId, turnId,
            writer: origin,
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#streamEventNotify,
            wakeWorkerNotify: this.#wakeWorkerNotify,
            injectWorker: this.#injectWorker,
            mimetypes: this.#mimetypes,
            tokenize: this.#tokenize,
            pushTelemetry: (event) => this.#telemetry.push(workspaceId, loopId, event),
            executors: this.#executors(),
        };
    }

    // Loads loops.flags (json column) and merges over DEFAULT_LOOP_FLAGS so
    // missing keys read as their documented defaults. Single read site —
    // ProposalPendingEvent.flags is constructed from this, and listeners
    // (Daemon broadcast, loop auto) share the result.
    async #loadLoopFlags(loopId: number): Promise<LoopFlags> {
        const row = await this.#db.engine_get_loop_flags.get<{ flags: string }>({ loop_id: loopId });
        if (row === undefined) return DEFAULT_LOOP_FLAGS;
        try {
            const parsed = JSON.parse(row.flags) as Partial<LoopFlags>;
            return { ...DEFAULT_LOOP_FLAGS, ...parsed };
        } catch {
            return DEFAULT_LOOP_FLAGS;
        }
    }

    // SPEC §scheme-surface: engine rejects writes whose origin is outside the target
    // scheme's manifest.writableBy.
    // - Read-side ops (READ, FIND, OPEN, FOLD) are not gated.
    // - SEND broadcast (path=null) has no target scheme; not gated.
    // - COPY: dst scheme writableBy applies.
    // - MOVE: both src (delete) and dst (write) schemes' writableBy apply.
    // - Schemes without a manifest are not gated (legacy / future allowance).
    #checkWritable(statement: PlurnkStatement, origin: WriterTier): DispatchResult | null {
        if (!MUTATING_OPS.has(statement.op)) return null;
        if (statement.op === "SEND" && statement.target === null) return null;

        // EXEC's target slot is `cwd`, not a scheme address. The op's
        // authority always belongs to the exec scheme regardless of cwd.
        if (statement.op === "EXEC") {
            return this.#denyIfDisallowed("exec", origin);
        }

        // Run control (FORK/WORK → worker://<name>, spawn or fork) is gated by worker://'s writableBy — its
        // body is a seed prompt, not a dst path, so the entry-COPY dst-parse below doesn't apply.
        // §machine-processes
        if (this.#isWorkerControl(statement)) return this.#denyIfDisallowed("worker", origin);

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.op === "COPY" ? (statement.body === null ? null : parsePath(statement.body)) : statement.body;
            const dstScheme = schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = schemeNameOf(statement.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = schemeNameOf(statement.target);
        return this.#denyIfDisallowed(target, origin);
    }

    // §search-gate (#406, owner ruling) — search runtimes only; everything else dispatches
    // untouched. A DUPLICATE (same runtime+command this loop) STRIKES AND SERVES: 409 (the
    // strike rail counts the turn failure; the failed-ops gate holds the terminal a turn)
    // carrying the prior ranked digest re-read live — the model sees its results again, the
    // engine never re-fetches, no provenance prose. The per-turn CAP is flood control: 429.
    async #gatedExec(statement: PlurnkStatement, ctx: PlurnkSchemeContext, loopId: number, turnId: number): Promise<DispatchResult> {
        const runtime = ("signal" in statement && typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
        const command = ("body" in statement && typeof statement.body === "string") ? statement.body : "";
        const verdict = this.#searchGate?.check(loopId, turnId, runtime, command) ?? { verdict: "pass" as const };
        if (verdict.verdict === "capped") {
            return { status: 429, error: `Per-turn search limit reached (${verdict.cap}).` };
        }
        if (verdict.verdict === "duplicate") {
            // {§stream-owner-scoped} — the prior ranked digest is the CALLER's own stream entry.
            const prior = await EntryCrud.readEntry(verdict.priorPathname, ctx, runtime, ctx.workerId);
            const raw = prior.entry?.channels["#results"]?.content ?? "";
            let results: unknown = raw;
            try { results = JSON.parse(raw); } catch { /* non-JSON results serve verbatim */ }
            return { status: 409, results };
        }
        return this.#run("exec", statement, ctx);
    }

    #denyIfDisallowed(schemeName: string | null, origin: WriterTier): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName);
        if (handler === undefined) return null;
        const manifest = (handler.constructor as { manifest?: SchemeManifest }).manifest;
        if (manifest === undefined) return null;
        if (manifest.writableBy.includes(origin)) return null;
        return { status: 403, error: `writer '${origin}' is not in writableBy for scheme '${schemeName}'` }; // §scheme-surface-writableby-403
    }

    // Per-loop flag gating. Schemes self-declare their flag affinity in
    // their manifest (excludedInAsk / requiresWeb /
    // requiresInteraction); SchemeRegistry.resolveForLoop returns the
    // active set under the loop's persisted flags. Anything outside the
    // set returns 403 — action-entry-as-outcome carries the rejection.
    async #checkFlagsGate(statement: PlurnkStatement, loopId: number): Promise<DispatchResult | null> {
        // Broadcast SEND has no scheme to gate.
        if (statement.op === "SEND" && statement.target === null) return null;

        const flags = await this.#loadLoopFlags(loopId);
        // Fast path: default flags gate nothing. (auto never gates.)
        if (!flags.noWeb && !flags.noInteraction && flags.mode === "act") return null;

        // §mode-ask-read-only — the ancient contract: an ask-mode loop NEVER changes the world. The
        // filesystem writes (EDIT/COPY-dest/MOVE/KILL touching the `file` scheme — each proposes disk
        // egress, §membership) are refused HERE, regardless of the scheme's read-activity, because
        // `file` stays active for READs. The EXEC host runtime is refused by its excludedInAsk scheme
        // below. This lived only in SPEC (line 65) with no anchor → no guard → it silently regressed.
        if (flags.mode === "ask") {
            const isFile = (t: PlurnkStatement["target"]): boolean => schemeNameOf(t) === "file";
            // Each branch narrows statement.op so statement.body is correctly typed (COPY dest is a
            // string to parse; MOVE dest is already a path). EDIT/KILL write the target; COPY writes
            // the dest; MOVE deletes the source AND writes the dest — any `file` touch is a write.
            let writesFilesystem = false;
            if (statement.op === "EDIT" || statement.op === "KILL") writesFilesystem = isFile(statement.target);
            else if (statement.op === "COPY") writesFilesystem = isFile(statement.body === null ? null : parsePath(statement.body));
            else if (statement.op === "MOVE") writesFilesystem = isFile(statement.target) || isFile(statement.body);
            if (writesFilesystem) {
                return { status: 403, error: `'${statement.op}' cannot change the filesystem in an ask-mode loop — ask is read-only (no side-effecting ops). Answer or advise the user directly; an act-mode loop is required to edit files.` };
            }
        }

        const active = this.#schemes.resolveForLoop(flags);
        // #367 — the steer NAMES the restriction and says DO NOT RETRY: the old vague "inactive under
        // current loop flags" invited an identical re-emit each turn → the StrikeRail's 508. An
        // unavailable op is not a failing one; the model must change course, not repeat.
        const restriction = flags.mode === "ask"
            ? "this is an ask-mode (read-only) loop — you cannot run commands or take host actions here"
            : flags.noWeb && flags.noInteraction ? "web and interaction are disabled for this loop"
            : flags.noWeb ? "web access is disabled for this loop"
            : "interaction is disabled for this loop";
        const check = (target: PlurnkStatement["target"]): DispatchResult | null => {
            const scheme = schemeNameOf(target);
            if (scheme === null) return null;
            if (active.has(scheme)) return null;
            return { status: 403, error: `'${scheme}' is unavailable: ${restriction}. Do NOT retry it — it is unavailable, not failing; answer or advise the user directly (an act-mode loop is required to use it).` };
        };

        if (this.#isWorkerControl(statement)) return check(statement.target); // body is a spawn/fork task, not a dst path
        if (statement.op === "COPY" || statement.op === "MOVE") {
            return check(statement.target) ?? check(statement.op === "COPY" ? (statement.body === null ? null : parsePath(statement.body)) : statement.body);
        }
        return check(statement.target);
    }

    // Run control is FORK/WORK (grammar 0.74.55), not COPY — its body
    // is the new worker's seed prompt, not a destination path. The COPY gates and #handleCopy
    // branch on this so they never parse the prompt as a dst path.
    #isWorkerControl(statement: PlurnkStatement): boolean {
        return statement.op === "FORK" || statement.op === "WORK"; // run control targets worker://<name> (grammar 0.74.55)
    }

    // FORK/WORK(worker://<name>):task — run control (grammar 0.74.55):
    //   • worker://self   → FORK: deep-copy the current worker's log into a new sister (Fork), then
    //     continue it with the prompt (§machine-processes-fork-copies-the-log).
    //   • worker://<name> → SPAWN: a fresh sister (empty log) named <name>, started on the prompt.
    //     A LIVE sister already holding <name> is a 409 conflict; a free or terminated name is
    //     reclaimed (§worker-scheme-spawn). The self form is fork; only a name spawns.
    // Both ride the daemon inject and obey the active-runs cap (508, §worker-scheme-cap).
    // FORK/WORK — run control (grammar 0.74.55). Both name a NEW run in the target authority
    // (worker://<name>) and carry its seed task in the body. WORK spawns a fresh worker; FORK branches
    // the current worker's log into a named sister. Replaces the COPY(worker://) overload — one verb, one
    // intent, so the model never conflates the target slot with the body (grammar#52).
    async #handleWorkerControl(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        const target = statement.target;
        if (target === null) return { status: 400, error: `${statement.op} requires a worker target (${statement.op}(worker://<name>))` };
        const name = target.kind === "url" ? (target.hostname ?? "") : ""; // §worker-scheme — run is the AUTHORITY (worker://<name>), not the path
        if (name === "") return { status: 400, error: `${statement.op} requires a worker name (worker://<name>)` };
        if (name === "self") return { status: 400, error: `'self' is the current run — ${statement.op} names a NEW run (worker://<name>)` };
        // {§entry-owner} — 'commons'/'plurnk' are the reserved owner rows, '~' the self-sigil; no spawn takes them.
        if (Owner.RESERVED.has(name)) return { status: 400, error: `'${name}' is a reserved worker name` };
        if (ctx.injectWorker === undefined) throw new Error("run control: injectWorker capability absent");
        const denied = await WorkerCap.deny(this.#db, ctx.workspaceId);
        if (denied !== null) return denied;
        const prompt = typeof statement.body === "string" ? statement.body : "";

        // §worker-delegation-inherits-flags — authority flows down the delegation edge: the child's live
        // loop runs with ITS DELEGATOR'S flags. A flagless (non-auto) child's every side-effecting op
        // proposes into a resolver-less void — 300s auto-cancel per attempt was the fan-out wedge.
        const flags = await this.#loadLoopFlags(ctx.loopId);

        // A name is frozen per worker but reclaimable across time (§machine-processes-worker-origin): a LIVE
        // sister holding it is a 409 (legible, never a raw UNIQUE 500); a free/terminated name reclaims.
        const live = await this.#db.worker_live_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
        if (live !== undefined) return { status: 409, error: `worker '${name}' is already running` };

        if (statement.op === "FORK") {
            // Branch the current worker's log into a named sister.
            const branchWorkerId = await Fork.fork(this.#db, ctx.workerId, name);
            await ctx.injectWorker({ workspaceId: ctx.workspaceId, workerId: branchWorkerId, prompt, flags });
            return { status: 200, body: name };
        }
        // WORK — a fresh worker sister named <name>.
        const row = await this.#db.fork_insert_worker.get<{ id: number }>({
            workspace_id: ctx.workspaceId, name, parent_worker_id: ctx.workerId, origin: ctx.writer,
        });
        if (row === undefined) throw new Error("run spawn: run insert returned no row");
        await ctx.injectWorker({ workspaceId: ctx.workspaceId, workerId: row.id, prompt, flags });
        return { status: 200, body: name };
    }

    async #handleCopy(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "COPY") throw new Error("unreachable");
        const srcPath = statement.target;
        // COPY is entry-copy only — run control (spawn/fork) moved to the FORK/WORK verbs
        // (grammar 0.74.55). COPY's body is a dest path (grammar §COPY); an unparseable dest → 400.
        const dstPath = statement.body === null ? null : parsePath(statement.body);
        if (srcPath === null) return { status: 400, error: "COPY requires source path" };
        if (dstPath === null) return { status: 400, error: "COPY destination must be a parseable path in the body slot" };
        return await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
    }

    async #handleMove(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "MOVE") throw new Error("unreachable");
        const srcPath = statement.target;
        const dstPath = statement.body;
        if (srcPath === null) return { status: 400, error: "MOVE requires source path" };
        // MOVE is relocation only — deletion is KILL's job (§move, §move-dev-null-not-special). The /dev/null
        // and null-body delete-by-MOVE back-compat is retired: no silent debt.
        if (dstPath === null) return { status: 400, error: "MOVE requires a destination; use KILL to delete" }; // §move-null-body-400

        const srcSchemeName = schemeNameOf(srcPath);
        if (srcSchemeName === null) return { status: 400, error: "MOVE source must be a URL path with a scheme" };
        if (!this.#schemes.has(srcSchemeName)) return { status: 501 };

        // Relocation: COPY then DELETE source (§move-relocation-deletes-source).
        const copyResult = await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
        if (copyResult.status >= 400) return copyResult;
        const srcPathname = pathnameFromPath(srcPath);
        // If the dest write is a pending proposal (file dest → §membership review), the
        // source-delete MUST wait until the dest actually lands — a rejected
        // proposal would otherwise lose the source. Thread it into the resolution:
        // dispatch deletes the source AFTER the dest applies on accept.
        if (copyResult.status === 202) {
            return { ...copyResult, attrs: { ...(copyResult.attrs as Record<string, unknown>), moveSource: { scheme: srcSchemeName, pathname: srcPathname } } };
        }
        const delResult = await this.#deleteEntry(srcSchemeName, srcPathname, ctx);
        if (delResult.status >= 400) return { status: delResult.status };
        return copyResult;
    }

    // KILL — scheme-polymorphic destroy (plurnk-grammar#203 / 0.28.0). Entry-KILL
    // permanently deletes the entry: the canonical delete now, MOVE→/dev/null
    // retired from the model's vocabulary. Process-KILL (exec:///) aborts the
    // running spawn's controller (the same teardown loop.cancel rides), addressed
    // by coordinate pathname (#203). The KILL body is an opaque
    // annotation with no runtime meaning; it survives into the log row's tx for
    // free via the statement serialization. Status: 200 killed · 404 unknown ·
    // 405 log:/// (append-only) · 403 writableBy (the #checkWritable gate, KILL ∈
    // MUTATING_OPS) · 200/410/304/404 exec (killed / killed-earlier / exited / unknown) · 501 no-kill/delete scheme.
    async #handleKill(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "KILL") throw new Error("unreachable");
        const path = statement.target;
        if (path === null) return { status: 400, error: "KILL requires a target path" };
        const schemeName = schemeNameOf(path);
        if (schemeName === null) return { status: 400, error: "KILL target must be a URL path with a scheme" };
        // KILL on log:/// erases the log row(s) — the model's DB-storage curation lever
        // (plurnk.md:36, :98), routed to Log.kill below via the killable.kill path. The old
        // "append-only" 405 forbade what the grammar requires; FOLD only collapses the render.
        // Process-KILL: any scheme whose handler exposes kill() aborts a live stream — the
        // exec handler, registered as "exec" + under every runtime tag (sh/node), so a tag-
        // addressed stream (sh:///l/t/s) routes here, not to deleteEntry. §exec
        const killable = this.#schemes.get(schemeName) as { kill?: (pathname: string, signal: number | null, ctx: SchemeCtx, scheme?: string) => Promise<{ status: number; error?: string }> } | undefined;
        if (killable !== undefined && typeof killable.kill === "function") {
            // Pass the model's OWN scheme so a stream-KILL error answers in the runtime tag the
            // model addressed (sh:///…), not the internal `exec` ({§fs-answer-in-canon}).
            const handlerCtx = this.#handlerContext(schemeName, ctx);
            return handlerCtx === null ? { status: 501 } : await killable.kill(pathnameFromPath(path), statement.signal, handlerCtx, schemeName);
        }
        if (schemeName === "worker") {
            // Entry-path present → KILL a worker-scope scratch ENTRY (delete it), self-only —
            // NOT run cancellation. The authority (hostname) names the owner, the pathname the
            // entry; only the path-ABSENT form (worker://<name>) terminates the run-as-actor. §worker-scheme
            const entryPath = path.kind === "url" ? (path.pathname ?? "") : "";
            if (entryPath !== "" && entryPath !== "/") {
                const workerHandler = this.#schemes.get("worker") as { killEntry: (s: PlurnkStatement, c: SchemeCtx) => Promise<{ status: number; error?: string }> };
                const handlerCtx = this.#handlerContext("worker", ctx);
                return handlerCtx === null ? { status: 501 } : await workerHandler.killEntry(statement, handlerCtx);
            }
            // Terminate an addressed worker's structured scope. `worker://self` = self.
            // An idle worker is a no-op 200; a missing worker is 404.
            const name = path.kind === "url" ? (path.hostname ?? "") : ""; // §worker-scheme — the worker is the AUTHORITY
            if (name === "") return { status: 400, error: "worker:// kill requires a worker name or ~ (worker://<name>)" };
            let workerId = ctx.workerId;
            if (name !== "~") {
                const row = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
                if (row === undefined) return { status: 404, error: `worker://${name} not found in this workspace` };
                workerId = row.id;
            }
            if (this.#cancelWorker === undefined) throw new Error("run kill: cancelWorker capability absent");
            // §op-synchronous — KILL is decisive. Await the one lifecycle owner so the
            // same-turn pending-work gate observes the complete subtree as terminal.
            await this.#cancelWorker(workerId, "killed via worker:// KILL");
            return { status: 200 };
        }
        if (!this.#schemes.has(schemeName)) return { status: 501 };
        // A host-effecting delete (file) returns 202 to PROPOSE — pass its attrs through so the proposal
        // carries the delete target to review (§isProposal fires on 202). Plurnk-internal deletes execute inline.
        const delResult = await this.#deleteEntry(schemeName, pathnameFromPath(path), ctx);
        return delResult.attrs !== undefined ? { status: delResult.status, attrs: delResult.attrs } : { status: delResult.status };
    }

    // Multi-file READ fan-out (SPEC §matcher-result — "the companion to FIND's survey"). A glob
    // READ target resolves to MANY files; READ returns one log row per file that matches, each
    // holding that file's matching lines. The matched SET is exactly FIND's survey (which files
    // + where — matchLines), so we reuse the scheme's own find, then READ each matched file. One
    // model command, N log rows — each row addresses its concrete file, so it folds/kills/re-READs
    // on its own. The running sequence counter in runTurn advances by rowsWritten.
    // A READ fans out (honors FIND) when it resolves to more than the single exact entry: a glob
    // or folder scope, OR a matcher (which selects per-match within whatever the target resolved).
    // A bare entry, body-less, is the one direct read. #286
    #readFansOut(statement: PlurnkStatement): boolean {
        if (statement.op !== "READ") return false;
        if ("body" in statement && (statement as ReadStatement).body !== null) return true;  // a matcher → per-match fan-out
        const t = statement.target;
        const p = t === null ? "" : (t.kind === "url" ? t.pathname : t.raw);
        if (p.includes("*")) return true;
        const schemeName = schemeNameOf(t);
        return p.endsWith("/") && schemeName !== null && this.#schemes.manifestFor(schemeName)?.folderScopes === true;
    }

    // Clone the READ onto one concrete match — the FIND already matched, so strip the body
    // (no re-match) and set <L> to its readable-row span. A null span (body-less folder/glob
    // fan-out) reads the whole entry. #286
    static #retargetRead(statement: PlurnkStatement, pathname: string, span: { rowStart: number; rowEnd: number } | null): PlurnkStatement {
        const t = statement.target;
        const target = t !== null && t.kind === "url"
            ? { ...t, pathname, raw: `${t.scheme}://${pathname}` }
            : { ...(t as { raw: string }), raw: pathname };
        const lineMarker = span !== null ? { marks: [span.rowStart, span.rowEnd] } : null;
        return { ...statement, target: target as PlurnkStatement["target"], lineMarker, body: null } as PlurnkStatement;
    }

    #standardEntryManifest(schemeName: string, statement: PlurnkStatement): SchemeManifest | null {
        const handler = this.#schemes.get(schemeName) as { find?: unknown } | undefined;
        if (typeof handler?.find === "function") return null;
        const target = statement.target;
        if (target === null || target.kind !== "url" || target.scheme === null) return null;
        const manifest = this.#schemes.manifestFor(schemeName);
        return manifest === undefined ? null : { ...manifest, name: target.scheme };
    }

    static #foldStoredEntryAuthority(statement: PlurnkStatement): PlurnkStatement {
        const target = statement.target;
        if (target === null || target.kind !== "url") return statement;
        const pathname = foldAuthorityIntoPath(target.hostname, target.pathname);
        return {
            ...statement,
            target: { ...target, hostname: null, pathname, raw: `${target.scheme}://${pathname}` },
        } as PlurnkStatement;
    }

    static #storedEntryMatchRead(statement: PlurnkStatement, pathname: string, span: { rowStart: number; rowEnd: number } | null, storage: boolean): PlurnkStatement {
        const target = statement.target;
        if (target === null || target.kind !== "url") return Dispatcher.#retargetRead(statement, pathname, span);
        const hostPrefix = target.hostname === null ? null : `/${target.hostname}`;
        const displayPath = hostPrefix !== null && pathname.startsWith(`${hostPrefix}/`)
            ? pathname.slice(hostPrefix.length)
            : pathname;
        const lineMarker = span === null ? null : { marks: [span.rowStart, span.rowEnd] };
        return {
            ...statement,
            target: storage
                ? { ...target, hostname: null, pathname, raw: `${target.scheme}://${pathname}` }
                : { ...target, pathname: displayPath, raw: `${target.scheme}://${target.hostname ?? ""}${displayPath}` },
            lineMarker,
            body: null,
        } as PlurnkStatement;
    }

    async #handleReadFanout(
        statement: PlurnkStatement,
        ctx: PlurnkSchemeContext,
        ids: { workerId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier; onDispatch?: (id: number) => void },
    ): Promise<DispatchResult> {
        const { workerId, loopId, turnId, sequence, origin, onDispatch } = ids;
        const schemeName = schemeNameOf(statement.target);
        const findStatement = { ...statement, op: "FIND" } as PlurnkStatement;
        const standardEntryManifest = schemeName === null ? null : this.#standardEntryManifest(schemeName, statement);
        const found = standardEntryManifest === null
            ? await this.#run(schemeName, findStatement, ctx)
            : await EntryFind.findWorkspaceEntries(Dispatcher.#foldStoredEntryAuthority(findStatement) as Extract<PlurnkStatement, { op: "FIND" }>, ctx, standardEntryManifest) as unknown as DispatchResult;
        const matches = (found.matches as Array<{ pathname: string; span: { lineStart: number; lineEnd: number; rowStart: number; rowEnd: number } | null }> | undefined) ?? [];
        const overflow = typeof found.overflow === "number" ? found.overflow : null;
        // §find-count-not-contents applies to WORK as well as rendering. A READ
        // over an over-budget selection writes the bounded FIND summary plus one
        // loud refusal; it never silently truncates and never materializes a
        // hidden prefix/suffix of the set.
        if (overflow !== null) {
            const findRowId = await this.#writeLog({ statement: { ...statement, op: "FIND" } as PlurnkStatement, result: found, workspaceId: ctx.workspaceId, workerId, loopId, turnId, sequence, origin });
            onDispatch?.(findRowId);
            const result: DispatchResult = {
                status: 413,
                error: `${overflow} matches exceed the READ materialization budget — narrow the target or matcher.`,
            };
            const readRowId = await this.#writeLog({ statement, result, workspaceId: ctx.workspaceId, workerId, loopId, turnId, sequence: sequence + 1, origin });
            onDispatch?.(readRowId);
            return { ...result, rowsWritten: 2 };
        }
        // Find-less scheme, a matcher/scope error, or zero matches → a single row carrying the
        // status, exactly like a non-fanned READ. The model sees the empty/failed result, not silence.
        if (found.status !== 200 || matches.length === 0) {
            const result: DispatchResult = { status: found.status === 200 ? 204 : found.status };
            const id = await this.#writeLog({ statement, result, workspaceId: ctx.workspaceId, workerId, loopId, turnId, sequence, origin });
            onDispatch?.(id);
            return { ...result, rowsWritten: 1 };
        }
        // One READ row per MATCH — deliver its source lines (or the whole entry for a body-less
        // folder/glob) while the logged statement carries the corresponding readable-row scope.
        // The delivery uses a raw line-slice rather than reinterpreting provenance as the scheme's
        // structural <L>. Read each distinct entry's content once, then line-slice per match. #286
        // §matcher-selection-signal — the SELECTION SUMMARY row: the internal FIND that located
        // the matches is WRITTEN (op=FIND, its full result — per-hit matchSpan + matchPath, the
        // canonical dialect coordinate) before the per-match deliveries, exactly as if the model
        // had FINDed then READ. On a degenerate single-line document the N delivery rows are
        // identical whole-file lines; the summary row is what tells the model its query hit N
        // times and WHERE (run30: two hits indistinguishable from failure; 17 retries, 508).
        const findRowId = await this.#writeLog({ statement: { ...statement, op: "FIND" } as PlurnkStatement, result: found, workspaceId: ctx.workspaceId, workerId, loopId, turnId, sequence, origin });
        onDispatch?.(findRowId);
        const wholeByPath = new Map<string, DispatchResult>();
        const fannedStatuses: number[] = [];
        let written = 1;
        for (const m of matches) {
            ctx.signal?.throwIfAborted();
            let whole = wholeByPath.get(m.pathname);
            if (whole === undefined) {
                const retargeted = standardEntryManifest === null
                    ? Dispatcher.#retargetRead(statement, m.pathname, null)
                    : Dispatcher.#storedEntryMatchRead(statement, m.pathname, null, true);
                whole = standardEntryManifest === null
                    ? await this.#run(schemeName, retargeted, ctx)
                    : await EntryOps.readWorkspaceEntry(
                        retargeted as ReadStatement,
                        ctx,
                        standardEntryManifest,
                    ) as DispatchResult;
                wholeByPath.set(m.pathname, whole);
            }
            const result = Dispatcher.#sliceMatch(whole, m.span);
            const deliveredStatement = standardEntryManifest === null
                ? Dispatcher.#retargetRead(statement, m.pathname, m.span)
                : Dispatcher.#storedEntryMatchRead(statement, m.pathname, m.span, false);
            const id = await this.#writeLog({ statement: deliveredStatement, result, workspaceId: ctx.workspaceId, workerId, loopId, turnId, sequence: sequence + written, origin });
            onDispatch?.(id);
            fannedStatuses.push(result.status);
            written++;
        }
        return { status: 200, rowsWritten: written, fannedStatuses };
    }

    // Deliver one match: the whole entry (body-less, span null) or the source lines at the span —
    // a RAW line-slice, so a structural mimetype (json item-index / xml) doesn't mis-slice a span
    // that is, by construction, source line numbers (#286).
    static #sliceMatch(whole: DispatchResult, span: { lineStart: number; lineEnd: number } | null): DispatchResult {
        if (whole.status !== 200 || span === null) return whole;
        const sliced = LineMarkerOps.sliceLines(typeof whole.content === "string" ? whole.content : "", { marks: [span.lineStart, span.lineEnd] });
        if (sliced.status !== 200) return { status: sliced.status, error: sliced.error };
        return { status: 200, content: sliced.text ?? "", mimetype: "text/markdown", startLine: sliced.startLine ?? span.lineStart };
    }

    // §model-entry — mirror a verbatim model emission back as an actionless `model` log row, so
    // the model can finally SEE its own prior output (and reason through its own syntax errors).
    // Born FOLDED by default (budget-neutral until OPENed); the turn-0 exemplar passes folded:false
    // (born open — the one worked example the model orients on, thinning the grammar). text/vnd.plurnk.
    async writeModelEntry({ verbatim, workerId, loopId, turnId, sequence, folded, origin = "model", reasoningItems }: {
        verbatim: string; workerId: number; loopId: number; turnId: number; sequence: number; folded: boolean; origin?: WriterTier;
        // {§sealed-reasoning-carrier} (#482) — a provider's SEALED reasoning ITEMS (the OpenAI
        // Responses standard: a LIST — a turn can carry N distinct-id items — each { id, subtype,
        // encrypted:[{data,format}] }, normalized by the provider tier) ride the mirror row's
        // `attrs.reasoning` VERBATIM: never decoded, never rendered into a packet (the packet renderer
        // reads no foreign attrs keys). The log/entry broadcast + readLog carry them to the client seam
        // per turn; agui projects one correlated REASONING_ENCRYPTED_VALUE span per item. NO synthesis
        // — id/subtype/blobs come from the wire, absent when the turn had none.
        reasoningItems?: ReadonlyArray<{ id: string | null; subtype: string; encrypted: ReadonlyArray<{ data: string; format: string | null }> }>;
    }): Promise<number> {
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId, loop_id: loopId, turn_id: turnId, sequence,
            origin, source: null, op: "model", suffix: "", signal: null,
            scheme: null, username: null, password: null, hostname: null, port: null,
            pathname: null, params: null, fragment: null, lineMarker: null,
            tx: "", mimetype_tx: "text/vnd.plurnk",
            rx: JSON.stringify({ content: verbatim, mimetype: "text/vnd.plurnk" }),
            mimetype_rx: "application/json",
            status_rx: 200, tokens: this.#tokenize(verbatim), state: "resolved", outcome: null,
            attrs: reasoningItems !== undefined && reasoningItems.length > 0 ? JSON.stringify({ reasoning: reasoningItems }) : "{}",
        });
        if (row === undefined) throw new Error("Dispatcher.writeModelEntry: insert returned no row");
        if (folded) await this.#db.engine_fold_log_entry.run({ id: row.id });
        return row.id;
    }

    // PLAN — the model's reasoning op (the 11th op). An ordinary op: dispatched like any
    // other, logged, and broadcast to the client as a log entry — but a pure no-op for
    // state (PLAN ∉ MUTATING_OPS); its body serializes into the log row's tx, no effect.
    #handlePlan(statement: PlurnkStatement): DispatchResult {
        if (statement.op !== "PLAN") throw new Error("unreachable");
        return { status: 200 };
    }

    // Same- and cross-scheme COPY share one orchestrator — §copy-cross-scheme-copy §move-cross-scheme-move
    async #copyOrchestration({ statement, srcPath, dstPath, ctx }: {
        statement: PlurnkStatement;
        srcPath: ParsedPath;
        dstPath: ParsedPath;
        ctx: PlurnkSchemeContext;
    }): Promise<DispatchResult> {
        const srcSchemeName = schemeNameOf(srcPath);
        const dstSchemeName = schemeNameOf(dstPath);
        if (srcSchemeName === null || dstSchemeName === null) return { status: 400, error: "COPY/MOVE require URL paths with schemes" };
        // {§worker-authority-carving} — the entry-copy seam is pathname-keyed; on worker:// it
        // addresses the COMMONS. A space's content moves via READ + EDIT, not COPY.
        for (const p of [srcPath, dstPath]) {
            if (p.kind === "url" && p.scheme === "worker" && (p.hostname ?? "") !== "") {
                return { status: 400, error: "COPY/MOVE address the commons (worker:///…); a space's content moves via READ + EDIT" };
            }
        }

        const srcHandler = this.#schemes.get(srcSchemeName);
        const dstHandler = this.#schemes.get(dstSchemeName);
        if (srcHandler === undefined || dstHandler === undefined) return { status: 501 };

        const srcPathname = pathnameFromPath(srcPath);
        const dstPathname = pathnameFromPath(dstPath);

        const srcResult = await this.#readEntry(srcSchemeName, srcPathname, ctx);
        if (srcResult.status !== 200 || srcResult.entry === null) return { status: 404, error: `COPY/MOVE source not found: ${srcSchemeName}://${srcPathname}` };  // §copy-missing-source-404 §move-missing-source-404
        const entry = srcResult.entry;

        // Destination read — the conflict/no-op verdict is deferred until the
        // to-be-written content is known (after <L> slice + tag resolution below),
        // so an identical re-copy resolves to 304 instead of a phantom 409.
        const dstExisting = await this.#readEntry(dstSchemeName, dstPathname, ctx);

        // Mimetype compatibility check against the destination scheme's manifest
        const dstManifest = (dstHandler.constructor as { manifest?: SchemeManifest }).manifest;
        const dstChannels = dstManifest?.channels ?? {};
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            const expectedMimetype = dstChannels[channelName];
            if (expectedMimetype !== undefined && expectedMimetype !== channelData.mimetype) {
                return { status: 415, error: `mimetype mismatch on channel '${channelName}': ${channelData.mimetype} vs ${expectedMimetype}` }; // cross-mimetype COPY/MOVE → 415, never coerce — §channel-mimetype-cross-mimetype-415
            }
        }

        // `<L>` source range slicing per SPEC.md §op-invariants (symmetric with READ
        // `<L>` — source range, no line-number prefix).
        // Applied to every channel of the source entry. Binary channels return
        // 415 since line semantics don't apply.
        const lineMarker = (statement as { lineMarker?: LineMarker | null }).lineMarker ?? null;
        let channels = entry.channels;
        if (lineMarker !== null) {
            const sliced: typeof entry.channels = {};
            for (const [channelName, channelData] of Object.entries(entry.channels)) {
                if (MimetypeBinary.isBinaryMimetype(channelData.mimetype)) {
                    return { status: 415, error: `cannot slice <L> on binary channel '${channelName}' (${channelData.mimetype})` };
                }
                const r = LineMarkerOps.sliceLinesRaw(channelData.content ?? "", lineMarker);
                if (r.status !== 200) return { status: r.status, error: r.error };
                sliced[channelName] = { ...channelData, content: r.text ?? "" };
            }
            channels = sliced;
        }

        // Tag resolution: signal = replace (§copy-signal-replaces-source-tags); absent/empty = carry from source (§copy-no-signal-carries-source-tags)
        const tags = (Array.isArray(statement.signal) && statement.signal.length > 0)
            ? statement.signal
            : entry.tags;

        // 304/409 on an existing destination (SPEC §copy): a re-copy that would write
        // exactly what's already there — same channel contents, same tags — is a no-op
        // (304), mirroring EDIT's 304-on-noop (§edit). A divergent destination is a real
        // collision (409); COPY/MOVE never clobbers.
        if (dstExisting !== null && dstExisting.status === 200 && dstExisting.entry !== null) {
            const dstChannels = dstExisting.entry.channels;
            const writeNames = Object.keys(channels).sort();
            const dstNames = Object.keys(dstChannels).sort();
            const sameContent = writeNames.length === dstNames.length
                && writeNames.every((n, i) => n === dstNames[i] && (channels[n]?.content ?? "") === (dstChannels[n]?.content ?? ""));
            const sameTags = [...tags].sort().join("") === [...dstExisting.entry.tags].sort().join("");
            if (sameContent && sameTags) return { status: 304 };  // identical → §copy-noop-304
            return { status: 409, error: `COPY/MOVE destination exists: ${dstSchemeName}://${dstPathname}` };  // §copy-conflict-409
        }

        const writeResult = await this.#writeEntry(dstSchemeName, dstPathname, { channels, tags }, ctx);
        // A file dest returns 202 (disk write → §membership review): propagate the
        // proposal so dispatch runs the gate + routes applyResolution to the dest.
        if (writeResult.status === 202) return { status: 202, attrs: writeResult.attrs, body: writeResult.body };
        return { status: writeResult.status, entryId: writeResult.entryId, created: writeResult.created };
    }

    // §send-premature-terminate — the unified PENDING SET, judged at the terminal's OWN dispatch
    // (post-batch: the emission's earlier ops already executed, so a same-turn KILL+[200] repairs in
    // ONE turn, and a same-turn WORK+[200] is caught — the spawn is live by the time the SEND lands).
    // pending = open streams ∪ live children ∪ THIS turn's retrievals (READ/FIND/OPEN, results unseen
    // until next packet). One rule, one steer, one repair family: nothing pending may be silently
    // discarded; 499 discards BY STATED INTENT and is never gated.
    async #pendingSet(workerId: number, turnId: number): Promise<string[]> {
        const pending: string[] = [];
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean } | undefined;
        if (openSubs.length > 0 || execHandler?.hasActiveSpawns?.(workerId) === true) pending.push("surviving streams");
        const liveChild = await this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId });
        if (liveChild !== undefined) pending.push("surviving workers");
        const observations = await this.#pendingObservations(workerId, turnId);
        if (observations.retrievals) pending.push("this turn's retrieval results (they land in the NEXT packet's Log)");
        if (observations.streamTerminations) {
            pending.push("completed stream results that land in the NEXT packet's Log");
        }
        if (observations.childTerminations) pending.push("worker results that arrived during this turn (they land NEXT turn)");
        return pending;
    }

    // Results cross an observation boundary only when they have appeared in a
    // packet. Completion alone is not delivery. Keep the three next-packet
    // producers in one classifier so SEND[200]'s discard gate and SEND[202]'s
    // empty-join decision cannot disagree about what remains unseen.
    async #pendingObservations(workerId: number, turnId: number): Promise<{
        retrievals: boolean;
        streamTerminations: boolean;
        childTerminations: boolean;
    }> {
        const [retrievals, streamTermination, childTermination] = await Promise.all([
            this.#db.engine_turn_retrievals.all<{ id: number }>({ turn_id: turnId }),
            this.#db.engine_worker_has_undelivered_stream_term
                .get<{ pending: number }>({ worker_id: workerId }),
            this.#db.engine_worker_has_undelivered_child_term
                .get<{ pending: number }>({ worker_id: workerId, turn_id: turnId }),
        ]);
        return {
            retrievals: retrievals.length > 0,
            streamTerminations: streamTermination !== undefined,
            childTerminations: childTermination !== undefined,
        };
    }

    // J — a live obligation to WAIT on: a spawned child or an open stream (NOT retrievals, which land
    // next turn regardless). The wait-side twin of #pendingSet's stream+child legs (§wait-obligation-matrix).
    async #hasLiveWork(workerId: number): Promise<boolean> {
        const openSubs = await this.#db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: workerId });
        if (openSubs.length > 0) return true;
        const execHandler = this.#schemes.get("exec") as { hasActiveSpawns?: (workerId: number) => boolean } | undefined;
        if (execHandler?.hasActiveSpawns?.(workerId) === true) return true;
        const liveChild = await this.#db.engine_worker_has_live_child.get<{ live: number }>({ worker_id: workerId });
        return liveChild !== undefined;
    }

    async #handleSendBroadcast(statement: PlurnkStatement, ctx: { workspaceId: number; workerId: number; loopId: number; turnId: number; turnParseErrors?: number }): Promise<DispatchResult> {
        if (statement.op !== "SEND") throw new Error("unreachable");
        const { workerId, loopId, turnId } = ctx;
        const status = statement.signal;
        if (status === null) return { status: 400 };
        const raw = statement.body === null ? "" : typeof statement.body === "string" ? statement.body : statement.body.raw;

        // [102]<T> — waiting is a mode of CONTINUING (grammar 0.75.0, the terminal redesign): park
        // up to T seconds, woken early by any arrival (stream/child conclusion, irc, inject), woken
        // at T regardless — a park ALWAYS has a next turn, so nothing can be orphaned. <-1> parks
        // indefinitely (the butler/worker pattern — owner-ruled ungated; the instrumentation renders
        // it legibly). Internally the parked state remains loops.status=202: the model-facing SIGNAL
        // retired, the engine's park state did not.
        // §join-blocking-collect (#354) — a READ(worker://running-child) this turn armed a join. A BARE
        // continue becomes an indefinite PARK: the blocking collect, on the same park machinery <-1>
        // uses. The armed READ said "I want this result"; parking IS the collect (the model never had
        // to know the park syntax — the engine holds the join). Any SEND clears the per-turn arm; a
        // terminal with a live child stays the existing premature-terminate steer (#354 decision #1).
        const joinArmed = this.#joinTargets.delete(loopId);
        if (status === 102 && statement.lineMarker === null && joinArmed) {
            if (!await this.#lifecycle.park(loopId, raw.length > 0 ? raw : "parked — awaiting a worker's result (blocking collect)")) {
                return { status: await this.#lifecycle.status(loopId) };
            }
            this.#parkDeadlines.set(loopId, -1); // indefinite: the bounded child's terminal is the wake edge
            return { status: 102, attrs: { parked: -1, join: true } };
        }

        // §wait-obligation-matrix — SEND[202] and the legacy SEND[102]<T> are one
        // obligation-checked join. A live
        // obligation (a spawned child or open stream, J) BLOCKS the loop until it concludes and
        // reawakens it (§worker-lifecycle-child-wake); a wait on nothing (∅) is already satisfied and
        // resolves like 200, so <-1>+∅ self-resolves rather than hang the agent; a pending own
        // retrieval (R) just lands next turn, so the wait continues.
        if (status === 202 || (status === 102 && statement.lineMarker !== null)) {
            const marks = statement.lineMarker?.marks[0];
            const seconds = typeof marks === "number" ? marks : -1; // bare 202 / absent T = indefinite, bounded by the join
            if (await this.#hasLiveWork(workerId)) {
                if (!await this.#lifecycle.park(loopId, raw.length > 0 ? raw : "waiting on live work")) {
                    return { status: await this.#lifecycle.status(loopId) };
                }
                this.#parkDeadlines.set(loopId, seconds);
                return { status: 202, attrs: { waiting: seconds } };
            }
            // Retrievals, fast stream conclusions, and child conclusions are
            // all complete-but-unobserved. Their wake edge may already have
            // fired, so do not park; continue directly to the packet that
            // materializes them.
            const observations = await this.#pendingObservations(workerId, turnId);
            if (observations.retrievals || observations.streamTerminations || observations.childTerminations) {
                return { status: 102 };
            }
            // The joined set is already drained. Awaiting an empty task group completes
            // immediately; it never parks and needs no corrective model turn.
            const finished = await this.#lifecycle.finish(loopId, 200, raw === "" ? null : raw);
            return {
                status: finished ? 200 : await this.#lifecycle.status(loopId),
                attrs: { joined: true, pending: 0 },
            };
        }

        // §send-300-choices — ask the operator and park (the answer returns via loop.inject).
        // The three-state cascade (owner design): PLURNK_QUESTIONS unset = ALLOWED (not enabled);
        // =0 = DENIED servicewide (a ceiling the client cannot override); ENABLED requires the
        // client to affirmatively pass it per workspace (settings.questions — the interactive client
        // with a human enables its own workspaces; headless/bench never asks). Enabled workspaces ALSO
        // get the questions.md teaching injected (docEntries) — capability and teaching gate as one.
        // Disabled → refused with a self-decide steer, never a park into the void.
        if (status === 300) {
            if (!(await WorkspaceSettings.questionsEnabled(this.#db, ctx.workspaceId))) {
                return { status: 409, error: "Operator asks ([300]) are not enabled in this environment — no one is watching to answer. Decide yourself and proceed: SEND[102] to continue, or [200] to conclude." };
            }
            // Owner ruling (#346): the question rides the SAME proposal system as file edits and
            // MCP auths — stop the world. Returning 202 here routes through the proposal seam
            // (#isProposal admits signal-300 SENDs): loop/proposal carries {question, choices},
            // loop.resolve's accept body IS the answer, and applyResolution writes it into the
            // model-facing rx — the answer arrives as the result of the ask itself. Timeout is
            // the standard §proposal-timeout-cancels. Zero options = an open question.
            const parts = raw.split(";").map((x) => x.trim()).filter((x) => x.length > 0);
            const [question = "", ...choices] = parts;
            return { status: 202, attrs: choices.length > 0 ? { question, choices } : { question } };
        }

        // [200] — terminate, gated by the pending set (post-batch). The row records the refused
        // attempt faithfully (status_rx=409, never erased); the loop stays a continue; the strike
        // couples in runTurn. [499] abandons and cancels the descendant scope.
        if (status === 200) {
            // §send-200-failed-ops (#363, owner ruling: never 200 over a failed op) — the failure
            // twin of the pending set: this turn's failed op results (and this emission's parse
            // errors, threaded — they mint as rows only after dispatch) are UNSEEN until the next
            // packet, so concluding over them is concluding blind. Refused 409; next turn, the
            // errors in-log and weighed, [200] stands. [499] below is never gated — declaring
            // failure IS weighing it.
            const failedRows = await this.#db.engine_turn_failures.all<{ id: number }>({ turn_id: turnId });
            const failCount = failedRows.length + (ctx.turnParseErrors ?? 0);
            if (failCount > 0) {
                return { status: 409, error: `Termination attempted despite ${failCount} failed operation(s) this turn. The errors land in your log next turn — weigh them, then conclude (or SEND[499] to abandon).` };
            }
            const pending = await this.#pendingSet(workerId, turnId);
            if (pending.length > 0) {
                // Kind-specific steer (owner wording, xpath/topo forensics): retrievals-only is
                // gemma's read-and-conclude idiom — no lever to pull, the results simply arrive;
                // KILL/park advice only muddies it. Streams/children keep the remedy steer.
                const retrievalsOnly = pending.every((k) => k.startsWith("this turn's retrieval results"));
                if (retrievalsOnly) {
                    // attrs.retrievalOnly — the strike decoupler (owner ruling): atomic-turn-
                    // pretrained models pair fetch-and-answer by habit; the refusal teaches,
                    // the strike executed. Engine reads this to skip the strike.
                    // #384 (owner wording, run48 requiem) — three lessons in one steer: it narrates
                    // "last turn" as HISTORY (the model reads log rows in the third person and never
                    // took "you"-steers as self-addressed), states the mechanism as law (retrievals
                    // FORCE an additional turn — not blame, physics), and prescribes the concluding
                    // emission's legal SHAPE (PLAN + SEND[200] only — no room for the justify-READ
                    // that re-armed this gate four times while she held the correct answer).
                    return { status: 409, error: "Last turn both performed retrieval operations and attempted to terminate. Retrieval operations force an additional turn to receive results for review and reaction. To conclude, only use PLAN and SEND[200] operations.", attrs: { retrievalOnly: true } };
                }
                return { status: 409, error: `Attempted [200] termination in a turn that performs retrieval or has surviving work: ${pending.join("; ")}. KILL what you no longer need; SEND[102] (or [102]<seconds>) to receive the rest; then conclude.` };
            }
            const finished = await this.#lifecycle.finish(loopId, 200, raw === "" ? null : raw);
            return { status: finished ? 200 : await this.#lifecycle.status(loopId) };
        }
        if (status === 499) {
            const finished = await this.#lifecycle.finish(loopId, 499, raw === "" ? null : raw);
            if (!finished) return { status: await this.#lifecycle.status(loopId) };
            await this.#cancelDescendants?.(workerId, raw === "" ? "parent abandoned its scope" : raw);
            return { status: 499 };
        }
        // Every other signal — 102 bare, 202 (retired as a terminal; now ordinary mid-comms), 1xx —
        // is a plain broadcast row: no loop transition.
        return { status };
    }

    async #run(
        schemeName: string | null,
        statement: PlurnkStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult> {
        if (schemeName === null) return { status: 400 };
        if (statement.op === "SEND" && statement.signal === 499 && statement.target?.kind === "url") {
            const entry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                owner_id: await Owner.commonsId(this.#db, ctx.workspaceId),
                scheme: schemeName,
                pathname: pathnameFromPath(statement.target),
            });
            if (entry !== undefined) {
                const subscription = await ChannelWrite.findActiveSubscription(this.#db, {
                    workerId: ctx.workerId,
                    entryId: entry.id,
                });
                if (subscription !== null && subscription.scheme === schemeName) {
                    const cancelled = await this.#liveSubscriptions.cancel(subscription.id);
                    return cancelled
                        ? { status: 200 }
                        : { status: 500, error: `subscription ${subscription.id} is durable but has no live cancellation handle` };
                }
            }
        }
        const handler = this.#schemes.get(schemeName) as Partial<Record<keyof SchemeHandler, SchemeMethod>> | undefined;
        if (handler === undefined) return { status: 501 };
        const methodName = statement.op.toLowerCase() as keyof SchemeHandler;
        const method = handler[methodName];
        if (typeof method !== "function") return { status: 501 };
        const addressedScheme = statement.target?.kind === "url" ? statement.target.scheme : null;
        const manifest = this.#schemes.manifestFor(schemeName);
        if (manifest === undefined) throw new Error(`scheme '${schemeName}' has no manifest`);
        return method.call(handler, statement, new SchemeCtxImpl(ctx, addressedScheme ?? schemeName, manifest, this.#liveSubscriptions));
    }

    // A status-202 result is a reviewable PROPOSAL (a side-effecting op — EDIT/EXEC/
    // directed write — paused for client resolution) UNLESS it is a broadcast SEND.
    // A broadcast SEND[202] is the model PARKING the loop (a terminal disposition,
    // plurnk.md), never a side-effect — #255: gating the propose/await path on the
    // bare 202 surfaced model speech as a loop/proposal and froze clients. The 202
    // is overloaded (proposal-pause vs parked-terminal); the op disambiguates it.
    static #isProposal(statement: PlurnkStatement, result: DispatchResult): boolean {
        // A broadcast SEND park is model speech, not a proposal (#255) — EXCEPT a [300] question,
        // which IS a proposal by owner ruling (#346: the same stop-the-world system as file edits).
        if (result.status !== 202) return false;
        if (statement.op === "SEND" && statement.signal === 300) return true;
        return !(statement.op === "SEND" && statement.target === null);
    }

    async #writeLog({
        statement, result, workspaceId, workerId, loopId, turnId, sequence, origin,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        workspaceId: number; workerId: number; loopId: number; turnId: number; sequence: number; origin: WriterTier;
    }): Promise<number> {
        const target = this.#extractTarget(statement.target);
        await this.#canonColumns(target, workspaceId); // {§fs-answer-in-canon} — columns speak canon; tx below stays verbatim
        const lineMarkerJson = "lineMarker" in statement && statement.lineMarker !== null
            ? JSON.stringify(statement.lineMarker as LineMarker)
            : null;
        // A proposal (status 202 from a side-effecting op) is written to the log in
        // state='proposed' until the proposal lifecycle resolves it; attrs holds the
        // scheme-supplied payload (file diff, exec command, etc.) the client renders
        // for review and the scheme consumes on accept. A broadcast SEND[202] is a
        // parked-terminal, NOT a proposal (#isProposal / #255) → state='resolved'.
        const isProposed = Dispatcher.#isProposal(statement, result);
        let attrsObj: Record<string, unknown> = (result.attrs !== undefined && result.attrs !== null)
            ? { ...(result.attrs as Record<string, unknown>) }
            : {};
        // EXEC produces a stream entry addressed by RUNTIME TAG as authority (§exec): it lives
        // at <runtime>:///<loop_seq>/<turn_seq>/<sequence> (e.g. sh:///1/1/2). That address is a
        // SEPARATE `stream` link in attrs — NOT an overload of `target`, which stays faithful to
        // the EXEC's own slot (the cwd, or the path to the executable). The log:/// coordinate
        // shares the trailing <loop>/<turn>/<seq>, so the op still correlates to its stream.
        // Runtime comes from statement.signal (EXEC's runtime slot), resolvable for failed execs
        // too; empty/absent = the default shell.
        if (statement.op === "EXEC") {
            const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({
                loop_id: loopId, turn_id: turnId,
            });
            if (seqs === undefined) throw new Error(`Dispatcher.#writeLog: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
            const runtime = (typeof statement.signal === "string" && statement.signal.length > 0) ? statement.signal : "sh";
            const coordPathname = `/${seqs.loop_seq}/${seqs.turn_seq}/${sequence}`;
            attrsObj.pathname = coordPathname;
            attrsObj.stream = `${runtime}://${coordPathname}`;
            // Mutate the in-memory result.attrs too: the dispatch path
            // hands originalResult.attrs to handler.applyResolution after
            // proposal accept (see ProposalLifecycle.workerApply). Both views —
            // the stored row AND the in-memory proposal — need the same
            // pathname so applyResolution writes the entry at the same URI.
            if (result.attrs !== undefined && result.attrs !== null) {
                (result.attrs as Record<string, unknown>).pathname = coordPathname;
            }
        }
        const attrs = JSON.stringify(attrsObj);
        const txJson = JSON.stringify(statement);
        const rxJson = JSON.stringify(result);
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: workerId,
            loop_id: loopId,
            turn_id: turnId,
            sequence: sequence,
            origin,
            source: null,  // dispatch entries are self-authored; §env-delta deltas set this
            op: statement.op,
            suffix: statement.suffix,
            signal: this.#signalToJson(statement.signal),
            scheme: target.scheme,
            username: target.username,
            password: target.password,
            hostname: target.hostname,
            port: target.port,
            pathname: target.pathname,
            params: target.params,
            fragment: target.fragment,
            lineMarker: lineMarkerJson,
            tx: txJson,
            mimetype_tx: "application/json",
            rx: rxJson,
            mimetype_rx: "application/json",
            status_rx: result.status,
            tokens: this.#tokenize(txJson) + this.#tokenize(rxJson),
            state: isProposed ? "proposed" : "resolved",
            outcome: null,
            attrs,
        });
        if (row === undefined) throw new Error("Dispatcher.#writeLog: INSERT ... RETURNING produced no row");
        return row.id;
    }

    // Normalize a parsed path for storage. The `file` scheme is a routing
    // internal — never stored, never rendered to the model. Both bare paths
    // and `file:///...` inputs collapse to scheme=null at this boundary, so
    // entries.scheme / log_entries.scheme never carry the string "file".
    #extractTarget(path: ParsedPath | null): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        params: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, params: null, fragment: null };
        // `local` (bare path) and `regex` (grammar 0.46 `#pattern#flags` target) carry no URL parts — store the raw text as the pathname for the log record, scheme=null.
        if (path.kind === "regex") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: path.raw, params: null, fragment: null }; // regex source — no decode
        if (path.kind === "local") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: decodePathParens(path.raw), params: null, fragment: null }; // #239 item 4
        const scheme = path.scheme === "file" ? null : path.scheme;
        // Every registered (plurnk-namespace) scheme uses its authority as a namespace segment — fold
        // it into the canonical pathname so known://x ≡ known:///x ≡ /x and the log keys identically to
        // the entry (/prompt/<run>/<loop>/<N>, /docs/x.md). A foreign web host (http://, unregistered) is NOT a
        // namespace: keep it in hostname. worker:// is the one registered EXCEPTION — its authority IS the
        // run selector (§worker-scheme), and worker://self must stay distinct from worker://name, so Run.ts
        // folds the owner into the storage path itself, never here.
        const foldNs = scheme !== null && scheme !== "worker" && this.#schemes.has(scheme);
        return {
            scheme, username: path.username, password: path.password,
            hostname: foldNs ? null : path.hostname, port: path.port,
            pathname: decodePathParens(foldNs ? foldAuthorityIntoPath(path.hostname, path.pathname) : path.pathname), // #239 item 4
            params: JSON.stringify(path.params), fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
