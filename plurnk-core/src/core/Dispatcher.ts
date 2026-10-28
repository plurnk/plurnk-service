import { parsePath } from "@plurnk/plurnk-parser";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import AmbientMembers from "./AmbientMembers.ts";
import { TurnDisposition, PathSyntax, Validator, isExecution, isRecord } from "@plurnk/plurnk-contracts";
import Turn from "./Turn.ts";
import type { BareStatement, CapabilityProjection, DispositionStatement, EditStatement, FindStatement, ForkStatement, KillStatement, NoteStatement, ParsedPath, PlurnkStatement, ReadStatement, SendStatement, WorkStatement } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "./Db.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import type ProposalLifecycle from "./ProposalLifecycle.ts";
import type ClientInteractions from "./ClientInteractions.ts";
import type { AppliedProposalResolution, ProposalSettlement } from "./ProposalLifecycle.ts";
import { foldAuthorityIntoPath, renderAddress, renderTarget, schemeNameOf } from "./plurnk-uri.ts";
import SessionName from "./SessionName.ts";
import Namespace from "./namespace.ts";
import FileAddress from "./FileAddress.ts";
import type { WriterTier, PlurnkSchemeContext } from "./scheme-types.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import type { EngineNotifications } from "./notifications.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";
import type LoopLifecycle from "./LoopLifecycle.ts";
import Results, { OperationFailureError } from "./results.ts";
import EffectPolicy from "../schemes/EffectPolicy.ts";
import type { ExecSource } from "./CoreSchemeServices.ts";
import { InvalidOperationResultError, MessageAttachments, type SchemeCtx, type SchemeHandler, type SchemeResult, type StoredEntryData } from "@plurnk/plurnk-schemes";
import type { LogCurationOutcome, LogCurationPlan } from "../schemes/Log.ts";
import ResourceMutations from "./ResourceMutations.ts";
import ResourceSelector from "./ResourceSelector.ts";
import { primaryTargetOf } from "./statement-primary.ts";
import LogVisibility from "./LogVisibility.ts";
import PacketWire, { type StoredLogRow } from "./packet-wire.ts";
import { isContextReceipt, reserved, resultPrefix, resultSize, unfitResult, type ContextFit } from "./ContextFit.ts";
import { TextCoordinates } from "@plurnk/plurnk-mimetypes";
import type EntryAddressBinding from "./EntryAddressBinding.ts";
import type { EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import SessionControlHandler from "./SessionControlHandler.ts";
import SessionControlAddress from "./SessionControlAddress.ts";
import KillHandler from "./KillHandler.ts";
import TurnDispositionHandler, { type CompletionEvidence, type PacketBoundaries } from "./TurnDispositionHandler.ts";
import ReplyMetadata from "./ReplyMetadata.ts";
import LogWriter from "./LogWriter.ts";
import LogEntryProjection from "./LogEntryProjection.ts";
import DataStatementRunner from "./DataStatementRunner.ts";
import ResourceBindings from "./ResourceBindings.ts";
import type EditSequence from "./EditSequence.ts";
import EntryRepresentation from "./EntryRepresentation.ts";
import DispatchAdmission from "./DispatchAdmission.ts";
import TurnSourceWriter from "./TurnSourceWriter.ts";


export type DispatchContext = {
    statement: PlurnkStatement;
    // {§emission-history}: ordinal in this turn's frozen content program, preserved through fan-out.
    emissionIndex?: number;
    workspaceId: number;
    sessionId: number;
    loopId: number;
    turnId: number;
    sequence: number;
    origin: WriterTier;
    // {§connection-lifecycle} — a person's client operation: the session whose log its `log:///`
    // addresses read (null: none).
    client?: { readonly contextSessionId: number | null };
    // The append-only log boundary visible when this admitted program entered
    // execution. Direct single-operation dispatch captures its own boundary.
    logSelectionMaxId?: number;
    editSequence?: EditSequence;
    // Durable identity is available before a proposal can be resolved; the
    // terminal row becomes externally visible only after that proposal settles.
    onDispatch?: (logEntryId: number) => void;
    onSettled?: (logEntryId: number) => void | Promise<void>;
    // {§op-methods-op-dispatch} — set on an operation dispatched on behalf of a glob: the row it writes
    // carries this under `attrs.fanout`, so a client presents the authored statement once.
    fanout?: { readonly target: string; readonly matched: number; readonly index: number; readonly count: number };
    remainingCommands?: number;
    failOnOperationError?: boolean;
    // {§tokenomics} — the turn's measure of the budget left for one more result; absent, a result lands whole.
    fit?: ContextFit;
};

export type DispatchResult = SchemeResult;

interface DispatchExecution {
    result: DispatchResult;
    commandsExecuted: number;
    commandsOmitted: number;
}

type TargetSelection = { result: DispatchResult } | {
    statements: readonly PlurnkStatement[];
    fanout?: { target: string; matched: number };
};

interface ResolvedClientEntryAddress {
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly target: string;
}

// {§scheme-address} One channel of a representation core computes, as a client reads it.
export interface ComputedClientChannel {
    readonly content: string;
    readonly mimetype: string;
    readonly state: StoredEntryData["channels"][string]["state"];
    readonly weight: number;
}

// {§scheme-address} What a client read acquires: a stored entry's address, the channels of a representation core
// computes, or the scheme's refusal.
export type ClientEntryAcquisition =
    | { readonly kind: "stored"; readonly address: ResolvedClientEntryAddress }
    | { readonly kind: "computed"; readonly target: string; readonly channels: Readonly<Record<string, ComputedClientChannel>> }
    | { readonly kind: "refused"; readonly result: DispatchResult };

export type SchemeMethod = (statement: PlurnkStatement, ctx: SchemeCtx) => Promise<DispatchResult>;
export type UnaryStatement = Exclude<PlurnkStatement, { op: "COPY" | "MOVE" }>;
type LogCurationHandler = {
    curate(statement: KillStatement, ctx: SchemeCtx, maxLogEntryId: number): Promise<LogCurationOutcome>;
};

export type SchemeWithEntryAddress = Pick<SchemeHandler, "resolveEntryAddress">;

// Op dispatch ({§op-methods-op-dispatch}): admission, operation-owner routing,
// durable log writing, and proposal lifecycle.
export default class Dispatcher {
    // {§log-kill-scope} The log scheme curates: the hook the registry's log handler publishes.
    static #curates(handler: SchemeHandler): handler is SchemeHandler & LogCurationHandler {
        return "curate" in handler && typeof handler.curate === "function";
    }

    static #failure(code: string, status: number, detail: string): DispatchResult;
    static #failure<F extends Readonly<Record<string, unknown>>>(
        code: string,
        status: number,
        detail: string,
        fields: F,
        extensions?: Readonly<Record<string, unknown>>,
    ): DispatchResult & F;
    static #failure(
        code: string,
        status: number,
        detail: string,
        fields: Readonly<Record<string, unknown>> = {},
        extensions: Readonly<Record<string, unknown>> = {},
    ): DispatchResult {
        return Results.failure("engine:dispatcher", code, status, detail, fields, extensions);
    }

    #db: Db;
    #schemes: SchemeRegistry;
    #mimetypes: Mimetypes;
    #weighContent: (text: string) => number;
    #notices: NoticeChannel;
    #proposals: ProposalLifecycle;
    #interactions: ClientInteractions;
    // Boot-discovered runtime executors, late-injected on Engine — thunked.
    #executors: () => ExecutorRegistry | undefined;
    // Per-loop abort signal, owned by Engine.runLoop — thunked.
    #loopSignal: (loopId: number) => AbortSignal | undefined;
    // {§matcher-dispatch} — the engine's derivation pump, awaited by a scheme whose
    // indexed dialect met a still-deriving index.
    #settleDerivations: (context: PlurnkSchemeContext) => Promise<void>;
    readonly #notify: EngineNotifications;
    // Per-turn running-session READ obligations. {§session-loop-lifecycle}
    #liveSubscriptions: LiveSubscriptions;
    #lifecycle: LoopLifecycle;
    #resourceMutations: ResourceMutations;
    #resourceSelector: ResourceSelector;
    #entryAddresses: EntryAddressBinding;
    #capabilities: CapabilityResolver;
    readonly #sessionControl: SessionControlHandler;
    readonly #kill: KillHandler;
    readonly #disposition: TurnDispositionHandler;
    readonly #logWriter: LogWriter;
    readonly #dataRun: DataStatementRunner;
    readonly #entries: EntryRepresentation;
    readonly #admission: DispatchAdmission;
    readonly #turnSources: TurnSourceWriter;

    constructor({ db, lifecycle, schemes, mimetypes, weigh, notices, proposals, interactions, executors, loopSignal, settleDerivations, notify, liveSubscriptions, entryAddresses }: {
        db: Db;
        lifecycle: LoopLifecycle;
        schemes: SchemeRegistry;
        mimetypes: Mimetypes;
        weigh: (text: string) => number;
        notices: NoticeChannel;
        proposals: ProposalLifecycle;
        interactions: ClientInteractions;
        executors: () => ExecutorRegistry | undefined;
        loopSignal: (loopId: number) => AbortSignal | undefined;
        settleDerivations: (context: PlurnkSchemeContext) => Promise<void>;
        notify: EngineNotifications;
        liveSubscriptions: LiveSubscriptions;
        entryAddresses: EntryAddressBinding;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#mimetypes = mimetypes;
        this.#weighContent = weigh;
        this.#notices = notices;
        this.#proposals = proposals;
        this.#interactions = interactions;
        this.#executors = executors;
        this.#loopSignal = loopSignal;
        this.#settleDerivations = settleDerivations;
        this.#notify = notify;
        this.#liveSubscriptions = liveSubscriptions;
        this.#entryAddresses = entryAddresses;
        this.#capabilities = new CapabilityResolver(db, schemes, executors);
        this.#lifecycle = lifecycle;
        this.#admission = new DispatchAdmission({
            schemes,
            capabilities: this.#capabilities,
            failure: Dispatcher.#failure,
        });
        this.#dataRun = new DataStatementRunner({
            schemes: this.#schemes,
            liveSubscriptions: this.#liveSubscriptions,
            resolveDataEntryAddress: (args) => this.#entries.resolveDataEntryAddress(args),
            prepareDataRepresentation: (args) => this.#entries.prepareDataRepresentation(args),
            failure: Dispatcher.#failure,
        });
        this.#entries = new EntryRepresentation({
            schemes: this.#schemes,
            weighContent: this.#weighContent,
            liveSubscriptions: this.#liveSubscriptions,
            entryAddresses: this.#entryAddresses,
            dataRun: this.#dataRun,
            workspaceRoot: (workspaceId) => this.#workspaceRoot(workspaceId),
            buildSchemeCtx: (ids) => this.#buildSchemeCtx(ids),
            failure: Dispatcher.#failure,
        });
        this.#resourceSelector = new ResourceSelector({
            schemes,
            admitRead: (statement, ctx) => this.#admission.checkCapabilities(statement, ctx),
            prepareDataRepresentation: (args) => this.#entries.prepareDataRepresentation({
                ...args,
                handler: args.handler,
            }),
        });
        this.#resourceMutations = new ResourceMutations({
            schemes,
            liveSubscriptions,
            checkWritable: (statement, origin, workspaceId) => this.#admission.checkWritable(statement, origin, workspaceId),
            checkCapabilities: (statement, ctx) => this.#admission.checkCapabilities(statement, ctx),
            editTargetIdentity: (statement, workspaceId, sessionId) => this.#editTargetIdentity(statement, workspaceId, sessionId),
            selection: this.#resourceSelector,
            resolveDataEntryAddress: (args) => this.#entryAddresses.resolve(args),
            readEntry: (scheme, address, ctx) => this.#entries.readEntry(scheme, address, ctx),
            writeEntry: (scheme, address, entry, ctx) => this.#entries.writeEntry(scheme, address, entry, ctx),
            deleteChannel: (scheme, address, channel, ctx) =>
                this.#entries.deleteChannel(scheme, address, channel, ctx),
            applyProposal: (statement, result, resolution, ids) =>
                this.#proposals.sessionApply(statement, result, resolution, ids),
        });
        this.#sessionControl = new SessionControlHandler({ db: this.#db, failure: Dispatcher.#failure });
        this.#kill = new KillHandler({
            db: this.#db,
            schemes: this.#schemes,
            liveSubscriptions: this.#liveSubscriptions,
            cancelSession: this.#notify.cancelSession,
            resolveDataEntryAddress: (args) => this.#entries.resolveDataEntryAddress(args),
            boundEntryContext: (routedScheme, address, ctx) => this.#entries.boundEntryContext(routedScheme, address, ctx),
            handlerContext: (scheme, ctx, authority) => this.#entries.handlerContext(scheme, ctx, authority),
            deleteEntry: (scheme, address, ctx) => this.#entries.deleteEntry(scheme, address, ctx),
            failure: Dispatcher.#failure,
        });
        this.#disposition = new TurnDispositionHandler({ db: this.#db, lifecycle: this.#lifecycle, unobservedFailureCount: this.#unobservedFailureCount.bind(this), pendingSet: this.#pendingSet.bind(this), hasLiveWork: this.hasLiveWork.bind(this) });
        this.#logWriter = new LogWriter({ db: this.#db, weighContent: this.#weighContent, extractTarget: this.#extractTarget.bind(this), canonColumns: this.#canonColumns.bind(this), signalToJson: this.#signalToJson.bind(this), isProposal: Dispatcher.#isProposal });
        this.#turnSources = new TurnSourceWriter({
            db: this.#db,
            schemes: this.#schemes,
            weighContent: this.#weighContent,
            logWriter: this.#logWriter,
            dataRun: this.#dataRun,
            buildSchemeCtx: (context) => this.#buildSchemeCtx(context),
            checkCapabilities: (statement, ctx) => this.#admission.checkCapabilities(statement, ctx),
            operationEvent: (context, phase, result) => this.#operationEvent(context, phase, result),
            noticeFilePaths: (context) => this.#noticeFilePaths(context),
            notifySettled: (context, logEntryId) => this.#notifySettled(context, logEntryId),
            failure: Dispatcher.#failure,
        });
    }

    // workspace → project_root, memoized: {§fs-namespace} fixes the root immutably at
    // workspace creation, so a process-lifetime cache can never go stale.
    #rootCache = new Map<number, string | null>();

    evictWorkspaceCache(workspaceId: number): void {
        this.#rootCache.delete(workspaceId);
    }
    async #workspaceRoot(workspaceId: number): Promise<string | null> {
        if (this.#rootCache.has(workspaceId)) return this.#rootCache.get(workspaceId) ?? null;
        const row = await this.#db.envelope_get_workspace.get<{ project_root: string | null }>({ id: workspaceId });
        const root = row?.project_root ?? null;
        this.#rootCache.set(workspaceId, root);
        return root;
    }

    // {§fs-namespace} — a file-class target's engine-authored address COLUMNS carry
    // the canonical key; tx keeps the operation spelling after the one durable request-evidence
    // projection. An un-canonicalizable spelling keeps its raw form.
    async #canonColumns(target: { scheme: string | null; pathname: string | null }, workspaceId: number): Promise<void> {
        if (target.scheme !== null || target.pathname === null) return;
        const key = Namespace.canonicalizeSpelling(target.pathname, await this.#workspaceRoot(workspaceId));
        if (key !== null) target.pathname = key;
    }

    async #editTargetIdentity(
        statement: EditStatement,
        workspaceId: number,
        _sessionId: number,
    ): Promise<string | null> {
        const target = this.#extractTarget(statement.target, workspaceId);
        await this.#canonColumns(target, workspaceId);
        return renderTarget(target, await this.#workspaceRoot(workspaceId));
    }

    // {§op-invariants} — a scoped KILL on an entry-bearing scheme is one EDIT with an empty
    // body over the same marker: prepared, gated, and merged as an EDIT while its log row
    // records the model's KILL. Schemes that implement kill() (streams) take the scope themselves;
    // the log's scoped KILL is curation.
    readonly #scopedEntryEdits = new WeakMap<KillStatement, EditStatement>();
    // {§log-kill-scope} — the NOTE a log KILL's body becomes, keyed so its row names what it distilled.
    readonly #distillations = new WeakMap<NoteStatement, string>();

    #scopedEntryEdit(statement: PlurnkStatement, workspaceId: number): EditStatement | null {
        if (statement.op === "EDIT") return statement;
        // {§op-invariants} a scoped KILL of an entry empties the span; {§op-invariants} a KILL with
        // a matcher removes each selected span, inside its scope when one is given.
        // Both are emptying EDITs; the log and every scheme with its own kill() keep their own path.
        if (statement.op !== "KILL" || (statement.lineMarker === null && statement.matcher === null)) return null;
        const cached = this.#scopedEntryEdits.get(statement);
        if (cached !== undefined) return cached;
        const schemeName = schemeNameOf(statement.target);
        if (schemeName === null || schemeName === "log") return null;
        const handler = this.#schemes.get(schemeName, workspaceId);
        if (handler === undefined || ("kill" in handler && typeof handler.kill === "function")) return null;
        const edit: EditStatement = {
            op: "EDIT",
            aside: statement.aside,
            metadata: statement.metadata,
            target: statement.target,
            lineMarker: statement.lineMarker,
            matcher: statement.matcher,
            body: "",
            position: statement.position,
        };
        this.#scopedEntryEdits.set(statement, edit);
        return edit;
    }

    async dispatch(context: DispatchContext): Promise<DispatchExecution> {
        await this.#operationEvent(context, "started");
        await this.#noticeFilePaths(context);
        const execution = await this.#dispatch(context);
        await this.#operationEvent(context, "settled", execution.result);
        return execution;
    }

    // {§fs-namespace} Authored operands, once, before internal fan-out: an absolute or home spelling
    // whose canonical address reads differently — the key inside the root, the absolute path beyond it.
    async #noticeFilePaths({ statement, origin, workspaceId, sessionId, loopId }: Pick<DispatchContext, "statement" | "origin" | "workspaceId" | "sessionId" | "loopId">): Promise<void> {
        if (origin !== "model" || isExecution(statement) || TurnDisposition.is(statement) || statement.op === "NOTE") return;
        const targets = statement.op === "COPY" || statement.op === "MOVE"
            ? [statement.source.target, statement.destination.target]
            : [statement.target];
        const normalized = targets.flatMap((target) => {
            if (target === null || schemeNameOf(target) !== "file") return [];
            const pathname = FileAddress.pathname(target);
            return typeof pathname === "string" && (pathname.startsWith("/") || Namespace.isHomeRelative(pathname))
                ? [{ target, pathname }] : [];
        });
        if (normalized.length === 0) return;
        const root = await this.#workspaceRoot(workspaceId);
        if (root === null || root === "/") return;
        for (const { target, pathname } of normalized) {
            const key = Namespace.canonicalizeSpelling(pathname, root);
            if (key === null) continue;
            const address = renderTarget({ scheme: null, pathname: key }, root, target);
            if (address === null || address.startsWith("file://") || address === pathname) continue;
            this.#notices.push(workspaceId, sessionId, loopId, {
                source: "scheme:file", kind: "path_normalized", level: "warn",
                directive: "YOU SHOULD address the resolved path.",
                message: `Path resolved to '${address || "."}'.`,
            });
        }
    }

    // {§notifications} One dispatch can produce several log rows.
    async #operationEvent(context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin" | "statement">, phase: "started" | "settled", result?: DispatchResult): Promise<void> {
        if (this.#notify.operationEventNotify === undefined) return;
        const { workspaceId, sessionId, loopId, turnId, sequence, origin, statement } = context;
        this.#notify.operationEventNotify(workspaceId, {
            sessionId, loopId, turnId, sequence, origin, statement,
            projectRoot: await this.#workspaceRoot(workspaceId), phase,
            ...(result === undefined ? {} : { result }),
        });
    }

    async #dispatch(context: DispatchContext, targetsResolved = false): Promise<DispatchExecution> {
        // {§op-methods-op-dispatch}: resolved glob targets cross the same cancellation boundary.
        this.#loopSignal(context.loopId)?.throwIfAborted();
        const execution = await ResourceBindings.using(this.#schemes, this.#buildSchemeCtx(context),
            (ctx) => this.#dispatchOne(context, ctx, targetsResolved));
        let { result } = execution;
        const edit = context.statement.op === "EDIT"
            ? context.statement
            : context.statement.op === "KILL" ? this.#scopedEntryEdits.get(context.statement) : undefined;
        if (edit !== undefined) {
            // {§op-methods-op-dispatch} — a proposal's apply result replaces the projected one; the
            // statement's merge facts ride every EDIT result, whichever route produced it.
            result = this.#resourceMutations.withMergeFacts(edit, result);
            this.#resourceMutations.settleEdit(edit, result);
        }
        // {§log-kill-scope} — a log KILL's body is the model's own NOTE row whatever the kill's
        // outcome: written after the kill's receipt at the next sequence, so it never falls inside the
        // kill's own selection, and kept when the kill misses, because what the model wrote about its
        // environment is the model's to retire, never the daemon's to drop.
        const distillation = Dispatcher.#distillationOf(context.statement);
        if (distillation !== null) {
            const note: NoteStatement = { op: "NOTE", aside: null, metadata: null, target: null, lineMarker: null, body: distillation.body, position: context.statement.position };
            this.#distillations.set(note, distillation.target);
            const noteContext: DispatchContext = { ...context, statement: note, sequence: context.sequence + 1 };
            delete noteContext.fanout;
            delete noteContext.emissionIndex;
            await ResourceBindings.using(this.#schemes, this.#buildSchemeCtx(noteContext), (ctx) => this.#dispatchOne(noteContext, ctx));
            result = Results.assert({ ...result, rowsWritten: Results.rowsWritten(result) + 1 });
        }
        return { ...execution, result };
    }

    static #distillationOf(statement: PlurnkStatement): { body: string; target: string } | null {
        if (statement.op !== "KILL" || statement.target === null || schemeNameOf(statement.target) !== "log" || typeof statement.body !== "string") return null;
        return statement.body.trim() === "" ? null : { body: statement.body, target: statement.target.raw };
    }

    // {§op-methods-op-dispatch} — the paths a FIND matched: each catalog item's, never a scope group's.
    static #matchedPaths(results: unknown): string[] {
        const items: unknown[] = Array.isArray(results) ? results : [];
        return items.flatMap((item): string[] => {
            const head: unknown = Array.isArray(item) ? item[0] : undefined;
            return isRecord(head) && !("items" in head) && typeof head.path === "string" ? [head.path] : [];
        });
    }

    static #globTarget(target: ParsedPath | null): boolean {
        if (target === null) return false;
        if (target.kind === "local") return PathSyntax.hasGlob(target.raw);
        // Authority-only session addresses name actors, not their resource trees.
        if (target.scheme === "session" && (target.pathname === "" || target.pathname === "/")) return false;
        return PathSyntax.hasGlob(target.pathname) || PathSyntax.hasGlob(target.hostname ?? "");
    }

    // {§op-methods-op-dispatch} Selection and exact execution share the ordinary owners.
    async #findTargets(survey: FindStatement, ctx: PlurnkSchemeContext): Promise<{ result: DispatchResult } | { targets: ParsedPath[]; matched: number }> {
        const found = await this.#dataRun.run(schemeNameOf(survey.target), survey, ctx);
        if (found.status >= 400) return { result: found };
        const paths = found.status < 300
            ? Dispatcher.#matchedPaths(found.results)
            : [];
        const matched = typeof found.matchingPathCount === "number" ? found.matchingPathCount : paths.length;
        if (survey.lineMarker !== null && matched !== paths.length) {
            throw new InvalidOperationResultError("Unbounded FIND did not return its complete resource selection.");
        }
        const targets = paths.map((path) => {
            const selected = survey.target?.fragment == null ? path : `${path.split("#")[0]}#${survey.target.fragment}`;
            const target = parsePath(selected);
            if (target === null) throw new InvalidOperationResultError(`FIND named an unparseable path: ${selected}`);
            return target;
        });
        return { targets, matched };
    }

    async #selectTargets(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<TargetSelection | null> {
        if (statement.op === "COPY" || statement.op === "MOVE") {
            if (![statement.source, statement.destination].some(({ target }) => Dispatcher.#globTarget(target))) return null;
            const resolved = { ...statement };
            for (const operand of ["source", "destination"] as const) {
                const selection = statement[operand];
                if (!Dispatcher.#globTarget(selection.target)) continue;
                const found = await this.#findTargets({
                    ...selection, op: "FIND", matcher: null, lineMarker: { marks: [1, -1] },
                    aside: statement.aside, position: statement.position, body: null,
                }, ctx);
                if ("result" in found) return found;
                if (found.targets.length !== 1) return { result: Dispatcher.#failure("target-cardinality", 400,
                    `${statement.op} ${operand} matched ${found.matched} resources; expected one.`, {},
                    { operand, matchingPathCount: found.matched, recovery: "Name one source and one destination per pair.", retryable: false }) };
                resolved[operand] = { ...selection, target: found.targets[0] };
            }
            return { statements: [resolved] };
        }
        if (!(statement.op === "READ" || statement.op === "EDIT" || statement.op === "KILL")) return null;
        if (!Dispatcher.#globTarget(statement.target) || (statement.op === "KILL" && schemeNameOf(statement.target) === "log")) return null;
        const found = await this.#findTargets({
            op: "FIND", aside: statement.aside, target: statement.target, metadata: statement.metadata,
            matcher: statement.op === "READ" ? statement.matcher : null,
            lineMarker: statement.op === "READ" ? null : { marks: [1, -1] }, body: null, position: statement.position,
        }, ctx);
        if ("result" in found) return found;
        if (found.targets.length === 0) return { result: Results.assert(statement.op === "READ" && statement.matcher !== null
            ? { status: 204, matched: 0, matcher: statement.matcher.raw, detail: `No line under ${statement.target!.raw} matched the pattern.` }
            : { status: 204, detail: `No path matched ${statement.target!.raw}.` }) };
        if (statement.op === "READ" && found.matched > found.targets.length) {
            this.#notices.push(ctx.workspaceId, ctx.sessionId, ctx.loopId, {
                source: "engine:dispatcher", kind: "read_fanout_bounded", level: "warn",
                directive: "YOU SHOULD narrow the glob, or FIND first.",
                message: `READ ${statement.target!.raw} matched ${found.matched} paths; the first ${found.targets.length} were selected.`,
            });
        }
        return { statements: found.targets.map((target) => ({ ...statement, target })), fanout: { target: statement.target!.raw, matched: found.matched } };
    }

    async #dispatchSelection(context: DispatchContext, selection: Exclude<TargetSelection, { result: DispatchResult }>): Promise<DispatchExecution> {
        const admitted = selection.statements.slice(0, context.remainingCommands);
        const results: DispatchResult[] = [];
        let rowsWritten = 0;
        for (const [index, statement] of admitted.entries()) {
            const { result } = await this.#dispatch({
                ...context, statement, sequence: context.sequence + rowsWritten,
                ...(selection.fanout === undefined ? {} : { fanout: { ...selection.fanout, index, count: admitted.length } }),
                ...(context.fit === undefined ? {} : { fit: reserved(context.fit, admitted.length - index - 1) }),
            }, true);
            results.push(result);
            rowsWritten += Results.rowsWritten(result);
            if (context.failOnOperationError && result.status >= 400 && !isContextReceipt(result)) break;
        }
        if (results.length === 0) throw new Error("Dispatch requires an admitted operation.");
        return { result: { ...(results.find(({ status }) => status >= 400) ?? results.at(-1)!), rowsWritten },
            commandsExecuted: results.length, commandsOmitted: selection.statements.length - admitted.length };
    }

    // {§op-methods-op-dispatch} Dispatch accounting is core-owned, never a scheme's extension data.
    static #singleExecution(result: SchemeResult): DispatchExecution {
        return { result, commandsExecuted: 1, commandsOmitted: 0 };
    }

    async #dispatchOne(context: DispatchContext, schemeCtx: PlurnkSchemeContext, targetsResolved = false): Promise<DispatchExecution> {
        const {
            statement,
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence,
            origin,
            onDispatch,
        } = context;
        const routed = await this.#route(context, schemeCtx, targetsResolved);
        let { result } = routed;
        const { resolved, curationPlan } = routed;
        // Child dispatch includes persistence and proposal settlement; their failures are
        // internal, not exceptions from a scheme handler.
        if (resolved !== null) return this.#dispatchSelection(context, resolved);
        if (result === undefined) throw new Error("Operation dispatch produced neither targets nor a result.");
        result = await this.#fitResult(context, statement, result);
        // {§configuration-repair-path}: decide admission before persisting a proposed row.
        const admission = this.#proposalAdmission(statement, result, workspaceId, origin);
        const { autoAccept } = admission;
        result = admission.result;
        // {§op-methods-op-dispatch} — a row on behalf of a glob names the statement it came from.
        if (context.fanout !== undefined) {
            const attrs = isRecord(result.attrs) ? result.attrs : {};
            result = { ...result, attrs: { ...attrs, fanout: context.fanout } };
        }
        // Persist log curation for forensics; packet rendering suppresses its
        // successful receipts while the exact state effects remain durable.
        // A running-session READ arms this turn's blocking collect.
        // {§session-loop-lifecycle}
        const logEntryId = await this.#logWriter.writeLog({
            statement,
            emissionIndex: context.emissionIndex,
            result,
            workspaceId,
            sessionId,
            loopId,
            turnId,
            sequence,
            origin,
            curationPlan,
            modelCallId: null,
        });
        onDispatch?.(logEntryId);
        // {§proposal} A 202 that proposes (a WAIT parks instead — #isProposal) settles in its own step.
        if (Dispatcher.#isProposal(statement, result)) return this.#settleProposedRow(context, schemeCtx, result, logEntryId, autoAccept);
        await this.#notifySettled(context, logEntryId);
        return Dispatcher.#singleExecution(result);
    }

    // {§op-methods-op-dispatch} The operation's owner, by statement: a refusal first — an unwritable target, a denied
    // capability, an unreadable matcher — then the one handler whose result is the row's, or the target selection a
    // glob resolves to. A scheme handler's exception is the row's 500 ({§scheme-surface}), never a throw.
    async #route(context: DispatchContext, schemeCtx: PlurnkSchemeContext, targetsResolved: boolean): Promise<{
        result: DispatchResult | undefined;
        resolved: Exclude<TargetSelection, { result: DispatchResult }> | null;
        curationPlan: LogCurationPlan | null;
    }> {
        const { statement, workspaceId, sessionId, loopId, turnId, sequence, origin } = context;
        let result: DispatchResult | undefined;
        let resolved: Exclude<TargetSelection, { result: DispatchResult }> | null = null;
        let curationPlan: LogCurationPlan | null = null;
        const denial = this.#admission.checkWritable(statement, origin, workspaceId)
            ?? await this.#admission.checkCapabilities(statement, schemeCtx)
            ?? DispatchAdmission.unreadableMatcher(statement);
        if (denial !== null) {
            result = denial;
        } else {
            // {§scheme-surface} Scheme-handler
            // exceptions become the action-entry's outcome (status 500), not a
            // thrown bubble. The log_entry is the durable record; engine never
            // skips it. Logging failures (#writeLog throws) are NOT caught —
            // those are system failures.
            try {
                const selection = targetsResolved ? null : await this.#selectTargets(statement, schemeCtx);
                if (selection !== null && !("result" in selection)) {
                    resolved = selection;
                } else if (selection !== null) {
                    result = selection.result;
                } else if (statement.op === "EDIT") {
                    result = await this.#resourceMutations.edit(statement, schemeCtx, context.editSequence);
                } else if (statement.op === "SEND" && statement.target === null) {
                    result = await this.#respond(statement, schemeCtx, loopId);
                } else if (statement.op === "NOTE") {
                    await Turn.recordSource(this.#db, turnId, "note", statement.body ?? "", { sequence });
                    const coordinate = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({ loop_id: loopId, turn_id: turnId });
                    if (coordinate === undefined) throw new Error(`NOTE has no turn coordinate for ${turnId}`);
                    const sessionName = await SessionName.forId(this.#db, sessionId);
                    const distilled = this.#distillations.get(statement);
                    result = { ...(distilled === undefined ? {} : { attrs: { distilled } }), status: 200, resource: renderAddress({ scheme: "note", authority: sessionName, pathname: `/${coordinate.loop_seq}/${coordinate.turn_seq}/${sequence}` }) };
                } else if (TurnDisposition.is(statement)) {
                    // {§op-shapes} — WAIT is the park; whatever it names is its label in the
                    // row, never a selected waker; arrivals or its duration end the park.
                    result = await this.#disposition.handle({ sessionId, loopId, turnId, origin }, statement);
                } else if (
                    statement.op === "KILL" && schemeNameOf(statement.target) === "log"
                ) {
                    const curation = await this.#runLogCuration(
                        statement,
                        schemeCtx,
                        context.logSelectionMaxId,
                    );
                    result = curation.result;
                    curationPlan = curation.plan;
                } else if (statement.op === "FORK" || statement.op === "WORK") {
                    // {§session-scheme} — a non-address path is the child's prompt resource.
                    const seeded = await this.#seedSpawnPrompt(statement, schemeCtx);
                    result = "result" in seeded ? seeded.result : await this.#sessionControl.handleSessionControl(seeded.statement, schemeCtx);
                } else if (statement.op === "COPY") {
                    result = await this.#resourceMutations.handleCopy(statement, schemeCtx);
                } else if (statement.op === "MOVE") {
                    result = await this.#resourceMutations.handleMove(statement, schemeCtx);
                } else if (statement.op === "KILL" && this.#scopedEntryEdit(statement, workspaceId) !== null) {
                    result = await this.#resourceMutations.edit(this.#scopedEntryEdits.get(statement)!, schemeCtx, context.editSequence);
                } else if (statement.op === "KILL") {
                    result = await this.#kill.handleKill(statement, schemeCtx);
                } else if (isExecution(statement)) {
                    // An execution routes unconditionally to its operation owner after
                    // the shared capability resolver admits its runtime/tool.
                    result = await this.#dataRun.run("exec", statement, schemeCtx);
                } else {
                    result = await this.#dataRun.run(schemeNameOf(statement.target), statement, schemeCtx); // {§op-methods-op-dispatch}
                }
            } catch (err) { // a scheme exception becomes the op's 500 outcome — {§scheme-surface}
                if (err instanceof InvalidOperationResultError) throw err;
                if (err instanceof OperationFailureError) {
                    result = err.result;
                } else if (err instanceof ConfigurationError) {
                    result = Results.configurationFailure(err);
                } else {
                    const scheme = schemeNameOf(primaryTargetOf(statement));
                    console.error(`Scheme '${scheme ?? "unknown"}' ${statement.op} threw outside its operation result contract:`, err);
                    result = Dispatcher.#failure(
                        "scheme-handler-threw",
                        500,
                        `The '${scheme ?? "unknown"}' scheme did not produce a result for ${statement.op}.`,
                        {},
                        {
                            stage: "scheme-dispatch",
                            scheme,
                            operation: statement.op,
                        },
                    );
                }
            }
        }
        return { result, resolved, curationPlan };
    }

    // {§configuration-repair-path} {§proposal-disposition} Whether a proposal settles itself under the effect
    // policy, decided before its row is persisted: an execution or a runtime-scheme SEND must declare its effect, the
    // runtime actor never grants itself authority, and a policy the configuration cannot read is the row's failure.
    #proposalAdmission(statement: PlurnkStatement, result: DispatchResult, workspaceId: number, origin: DispatchContext["origin"]): { autoAccept: boolean; result: DispatchResult } {
        let autoAccept = false;
        if (Dispatcher.#isProposal(statement, result)) {
            const effect = isRecord(result.attrs) ? result.attrs.effect : undefined;
            const mustDeclareEffect = isExecution(statement) || (statement.op === "SEND"
                && this.#schemes.isRuntimeScheme(schemeNameOf(statement.target) ?? "", workspaceId));
            if (mustDeclareEffect || effect !== undefined) {
                if (!EffectPolicy.isEffect(effect)) {
                    throw new InvalidOperationResultError("Execution proposal omitted its canonical effect fact.");
                }
                // {§proposal-disposition}: the runtime cannot grant itself effect authority.
                try { autoAccept = origin !== "_plurnk" && EffectPolicy.decide(effect) === "auto"; }
                catch (cause) {
                    if (!(cause instanceof ConfigurationError)) throw cause;
                    result = Results.configurationFailure(cause);
                }
            }
        }
        return { autoAccept, result };
    }

    // Proposal lifecycle (SPEC.md {§engine-rails} + {§methods}; {§proposal}). A
    // side-effecting op that returned 202 was written state='proposed'; an automatic acceptance applies at once,
    // otherwise dispatch PAUSES on a per-entry waiter until resolution arrives via Engine.resolveProposal (a client
    // resume, core-owned disposition, or timeout). The post-resolution status replaces 202 in the result the caller
    // sees, so runTurn never branches on a pending state.
    async #settleProposedRow(context: DispatchContext, schemeCtx: PlurnkSchemeContext, result: DispatchResult, logEntryId: number, autoAccept: boolean): Promise<DispatchExecution> {
        const { statement, workspaceId, sessionId, loopId, turnId } = context;
        if (autoAccept) {
            await this.#proposals.recordDecision(logEntryId, { decision: "accept" });
            const initialSettlement = await this.#applyProposal(context, schemeCtx, result, { decision: "accept" }, logEntryId);
            const effective = await this.#resourceMutations.settleProposal({
                statement,
                result,
                settlement: initialSettlement,
                ctx: schemeCtx,
                ids: { workspaceId, sessionId, loopId, turnId, logEntryId },
            });
            const post = await this.#proposals.applyResolution(logEntryId, effective);
            await this.#notifySettled(context, logEntryId);
            return Dispatcher.#singleExecution(post);
        }
        // Register the resolution waiter SYNCHRONOUSLY before any await
        // yields. A same-tick resolveProposal() (e.g. from a test that
        // awaits the onDispatch callback and immediately resolves) must
        // find the waiter registered — adding an await between insert
        // and waiter-registration would open a race window.
        // Core derives one validated projection from the durable row for both
        // this live event and reconnect discovery ({§proposal-projection}). Its
        // disposition is also the one automatic settlement decision: policy is
        // not an observer and cannot silently degrade into client ownership.
        let resolutionPromise: Promise<AppliedProposalResolution>;
        try {
            resolutionPromise = this.#proposals.awaitResolution(logEntryId, this.#loopSignal(loopId));
            const event = await this.#proposals.pending(logEntryId);
            if (event !== null) {
                this.#proposals.settleOwned(event);
                this.#proposals.notifyPending(event);
            }
        } catch (cause) {
            await this.#proposals.failPreparation(logEntryId, cause);
            await this.#notifySettled(context, logEntryId);
            throw cause;
        }
        const resolution = await resolutionPromise;
        // Run the scheme's applyResolution hook on accept (writes the
        // file, spawns the process, etc.). Its operation result is
        // preserved: an apply failure keeps its original status and
        // Problem Details instead of masquerading as a client rejection.
        const initialSettlement = await this.#applyProposal(context, schemeCtx, result, resolution, logEntryId);
        const effective = await this.#resourceMutations.settleProposal({
            statement,
            result,
            settlement: initialSettlement,
            ctx: schemeCtx,
            ids: { workspaceId, sessionId, loopId, turnId, logEntryId },
        });
        const post = await this.#proposals.applyResolution(logEntryId, effective);
        await this.#notifySettled(context, logEntryId);
        return Dispatcher.#singleExecution(post);
    }

    // {§tokenomics} — a result the model asked for arrives whole when it fits the remaining budget;
    // otherwise the row is its size and address — a READ of lines above the longest prefix of them that
    // fits — and the result stays where it was read from.
    async #fitResult(context: DispatchContext, statement: PlurnkStatement, result: DispatchResult): Promise<DispatchResult> {
        if (context.fit === undefined || (statement.op !== "READ" && statement.op !== "FIND")) return result;
        if (result.status >= 300 || typeof result.content !== "string" || result.content.length === 0) return result;
        const remaining = await context.fit.remaining();
        if (remaining === null) return result;
        const tokens = await this.#rowTokens(context, statement, result);
        if (tokens <= remaining) return result;
        const range = result.range === undefined ? undefined : Validator.assertRangeExtent(result.range);
        const size = resultSize({ range, content: result.content });
        const retained = statement.op === "READ"
            ? { content: null, mimetype: null, channel: result.channel ?? null, ...(range === undefined ? {} : { range }) }
            : { ...(range === undefined ? {} : { range }), ...Object.fromEntries(["matchingPathCount", "matchLocationCount", "itemsWeightTotal"].flatMap((key) => key in result ? [[key, result[key]]] : [])) };
        const receipt = (delivered: number): DispatchResult => unfitResult(retained, size, tokens, remaining, statement.op, delivered);
        if (statement.op !== "READ" || size.unit !== "line") return receipt(0);
        const whole: DispatchResult & { readonly content: string } = { ...result, content: result.content };
        const withPrefix = (count: number): DispatchResult => {
            const prefix = resultPrefix(whole, count);
            const carried = Object.fromEntries(["content", "mimetype", "startLine", "lineAnchors", "lineNumberWidth", "lineOrdinals", "matches", "range"]
                .flatMap((key) => prefix[key] === undefined ? [] : [[key, prefix[key]]]));
            return { ...receipt(count), ...carried };
        };
        // The longest prefix whose row, in its receipt shape, fits: the whole is known not to.
        let fits = 0;
        let bound = TextCoordinates.logicalLines(whole.content).length - 1;
        while (fits < bound) {
            const probe = Math.ceil((fits + bound) / 2);
            if (await this.#rowTokens(context, statement, withPrefix(probe)) <= remaining) fits = probe;
            else bound = probe - 1;
        }
        return fits === 0 ? receipt(0) : withPrefix(fits);
    }

    // The tokens the row would charge the packet, rendered as the log renders it ({§tokenomics}).
    async #rowTokens({ workspaceId, sessionId, loopId, turnId, sequence, origin }: DispatchContext, statement: PlurnkStatement, result: DispatchResult): Promise<number> {
        const record = await this.#logWriter.record({ statement, result, workspaceId, sessionId, loopId, turnId, sequence, origin, curationPlan: null, modelCallId: null });
        const seqs = await this.#db.engine_loop_turn_seqs.get<{ loop_seq: number; turn_seq: number }>({ loop_id: loopId, turn_id: turnId });
        if (seqs === undefined) throw new Error(`Dispatcher.#rowTokens: loop_turn_seqs returned no row for loop=${loopId} turn=${turnId}`);
        const row: StoredLogRow = {
            ...record, id: null, loop_seq: seqs.loop_seq, turn_seq: seqs.turn_seq,
            folded: LogVisibility.serialize(LogVisibility.OPEN), producer: origin === "model" ? "model" : "_plurnk",
        };
        return PacketWire.rowTokens(PacketWire.entryView(row), this.#weighContent, { projectRoot: await this.#workspaceRoot(workspaceId) });
    }

    async #notifySettled(context: DispatchContext, logEntryId: number): Promise<void> {
        await context.onSettled?.(logEntryId);
        await this.#notify.operationSettledNotify?.(context.workspaceId, logEntryId);
    }

    // {§session-initialization-entry} Whether a survey selects anything: its FIND run through the scheme context and
    // owner its dispatch would use, writing no row. A survey the FIND refuses counts as selecting, so its dispatch reports it.
    async selects(survey: FindStatement, ids: { workspaceId: number; sessionId: number; loopId: number; turnId: number; origin: WriterTier }): Promise<boolean> {
        const found = await ResourceBindings.using(this.#schemes, this.#buildSchemeCtx(ids),
            (ctx) => this.#dataRun.run(schemeNameOf(survey.target), survey, ctx));
        return found.status >= 300 || !Array.isArray(found.results) || found.results.length > 0;
    }

    capabilityProjection(workspaceId: number): Promise<CapabilityProjection> {
        return this.#admission.capabilityProjection(workspaceId);
    }

    readClientEntry(context: {
        target: ParsedPath;
        workspaceId: number;
        sessionId: number;
    }): Promise<ClientEntryAcquisition | null> {
        return this.#entries.readClientEntry(context);
    }

    bindEntryAddress(
        target: ParsedPath,
        ctx: PlurnkSchemeContext,
    ): Promise<PreparedRepresentation | null> {
        return this.#entries.bindEntryAddress(target, ctx);
    }

    readExecSource(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ExecSource> {
        return this.#entries.readExecSource(statement, ctx);
    }

    // The one place per-dispatch coordinates are built. Functionality resolves by workspace
    // ({§actor-boundary}); consumers read the built PlurnkSchemeContext
    // and never re-derive.
    #buildSchemeCtx(ids: {
        workspaceId: number; sessionId: number; loopId: number; turnId: number; sequence?: number; origin: WriterTier;
        client?: { readonly contextSessionId: number | null };
    }): PlurnkSchemeContext {
        const { workspaceId, sessionId, loopId, turnId, sequence, origin, client } = ids;
        const context: PlurnkSchemeContext = {
            db: this.#db,
            workspaceId, sessionId, loopId, turnId,
            ...(sequence === undefined ? {} : { sequence }),
            writer: origin,
            ...(client === undefined ? {} : { client }),
            resources: { capture: (targets) => ResourceBindings.using(this.#schemes, context,
                (bound) => this.#resourceSelector.capture(targets, bound)) },
            replyToMessage: (statement) => this.#respond(statement, context, loopId),
            signal: this.#loopSignal(loopId),
            streamEventNotify: this.#notify.streamEventNotify,
            wakeSessionNotify: this.#notify.wakeSessionNotify,
            injectSession: this.#notify.injectSession,
            mimetypes: this.#mimetypes,
            weigh: this.#weighContent,
            // {§exec-stream} — a runtime scheme's default channel is its own (stdout), never the
            // catalog fallback `body`; resolved through the same registry the writable gate reads.
            defaultChannelFor: (scheme) => this.#schemes.defaultChannelFor(scheme, context.workspaceId),
            settleDerivations: () => this.#settleDerivations(context),
            pushNotice: (notice) => this.#notices.push(workspaceId, sessionId, loopId, notice),
            // {§membership-auto-add} — the model's reads reach the untracked universe and admit what they read.
            ...(origin === "model" && this.#notify.admitMembers !== undefined && AmbientMembers.enabled() ? {
                ambientMembers: AmbientMembers.seam({
                    db: this.#db, workspaceId, signal: this.#loopSignal(loopId), mimetypes: this.#mimetypes,
                    admit: (files) => this.#notify.admitMembers!({ workspaceId, sessionId }, files),
                    notice: (notice) => this.#notices.push(workspaceId, sessionId, loopId, notice),
                }),
            } : {}),
            requestInteraction: (request, signal = this.#loopSignal(loopId)) => this.#interactions.request(
                request,
                { workspaceId, sessionId, loopId, turnId },
                signal,
            ),
            executors: this.#executors(),
        };
        return context;
    }

    capabilityDenial(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<SchemeResult | null> {
        return this.#admission.capabilityDenial(statement, ctx);
    }

    referenceVisibility(ctx: PlurnkSchemeContext): Promise<(pathname: string) => boolean> {
        return this.#admission.referenceVisibility(ctx);
    }

    writeEmissionAttempt(params: {
        verbatim: string; sessionId: number; loopId: number; turnId: number; sequence: number;
        modelCallId: number;
    }): Promise<number> {
        return this.#turnSources.writeEmissionAttempt(params);
    }

    writeEmission(params: {
        content: string; sessionName: string; loopSeq: number; turnSeq: number;
        sessionId: number; loopId: number; turnId: number; sequence: number;
    }): Promise<number> {
        return this.#turnSources.writeEmission(params);
    }

    writeReasoning(params: {
        content: string; sessionName: string; loopSeq: number; turnSeq: number;
        sessionId: number; loopId: number; turnId: number; sequence: number; fit: ContextFit | undefined;
    }): Promise<number | null> {
        return this.#turnSources.writeReasoning(params);
    }

    // {§session-scheme} WORK and FORK overload their slot by scheme: a `session://`
    // path is always the child's address (and keeps the address rules); a path of any other scheme
    // is read whole and becomes the child's prompt, composed with the body as BARE's combined form.
    // The durable row keeps the authored statement; only the handler sees the composed one, with no
    // target, so the child is auto-named exactly as when the slot is empty.
    async #seedSpawnPrompt(
        statement: WorkStatement | ForkStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<{ statement: WorkStatement | ForkStatement } | { result: DispatchResult }> {
        if (statement.target === null || SessionControlAddress.isSessionScheme(statement.target)) return { statement };
        const read: ReadStatement = { ...statement, op: "READ", matcher: null, body: null, lineMarker: { marks: [1, -1] } };
        const denial = await this.#admission.checkCapabilities(read, ctx);
        if (denial !== null) return { result: denial };
        const result = Results.assertReadResult(await this.#dataRun.run(schemeNameOf(read.target), read, ctx));
        if (result.status !== 200 && result.status !== 204) return { result };
        if (result.content !== null && typeof result.content !== "string") {
            throw new InvalidOperationResultError(`${statement.op} prompt resource READ returned non-text content.`);
        }
        const prompt = [result.content ?? "", statement.body ?? ""].filter((part) => part !== "").join("\n\n");
        if (prompt.trim() === "") {
            return { result: Dispatcher.#failure(
                "spawn-prompt-empty", 422, `${statement.op} has no prompt text: the resource is empty and there is no body.`, {},
                { recovery: `Write the prompt on the lines beneath the ${statement.op} fence line, or name a resource that holds it.`, retryable: false },
            ) };
        }
        return { statement: { ...statement, target: null, body: prompt } };
    }

    prepareBarePrompt(
        context: Pick<DispatchContext, "workspaceId" | "sessionId" | "loopId" | "turnId" | "sequence" | "origin"> & { statement: BareStatement },
    ): Promise<{ prompt: string } | { result: DispatchResult }> {
        return this.#turnSources.prepareBarePrompt(context);
    }

    recordBareResult(
        context: Omit<DispatchContext, "statement"> & { statement: BareStatement },
        result: DispatchResult,
        modelCallId: number | null,
    ): Promise<DispatchResult> {
        return this.#turnSources.recordBareResult(context, result, modelCallId);
    }


    // {§message-completion}: message content is literal; only its header selects a destination.
    async #respond(statement: SendStatement, schemeCtx: PlurnkSchemeContext, loopId: number): Promise<DispatchResult> {
        const options = ReplyMetadata.read(statement.metadata);
        if ("failure" in options) return options.failure;
        const target = statement.target;
        let repliedTo: string[];
        let speechOnly = false;
        if (target === null) {
            const open = await this.#db.engine_open_messages.get<{ key_path: string }>({ loop_id: loopId });
            // {§message-completion} — with none open, the reply is speech to the loop's latest message:
            // delivered to its originating client, its outcome unchanged.
            const message = open ?? await this.#db.message_latest_published.get<{ key_path: string }>({ loop_id: loopId });
            if (message === undefined) return Dispatcher.#failure(
                "send-target-required", 400, "SEND has no recipient and its loop has no published message.", {},
                { recovery: "Name a recipient address.", retryable: false },
            );
            repliedTo = [message.key_path];
            speechOnly = open === undefined;
        } else {
            const message = await this.#db.message_source_by_address.get<{ key_path: string }>({
                workspace_id: schemeCtx.workspaceId, path: target.raw,
            });
            if (message === undefined) return Dispatcher.#failure(
                "message-not-found", 404, `No accepted message exists at ${target.raw}.`, {}, { retryable: false },
            );
            repliedTo = [message.key_path];
        }
        const captured = await MessageAttachments.capture(options.metadata, schemeCtx.resources!, "message:reply");
        if ("failure" in captured) return captured.failure;
        return { status: 200, repliedTo,
            ...(options.completion === null || speechOnly ? {} : { completion: options.completion }),
            ...(captured.attachments.length === 0 ? {} : { attachments: MessageAttachments.receipts(captured.attachments) }) };
    }

    async settleProgram(ctx: { workspaceId: number; sessionId: number; loopId: number; turnId: number; origin: WriterTier }, waits: readonly DispositionStatement[], completionAllowed: boolean): Promise<number> {
        const result = await this.#disposition.settle(ctx, waits, completionAllowed);
        if (typeof result.detail === "string") this.#notices.push(ctx.workspaceId, ctx.sessionId, ctx.loopId, {
            source: "engine:turn", kind: "results_pending", level: "info", message: result.detail,
        });
        return result.status;
    }

    // {§loop-completion}: judge observation boundaries after the whole program settles.
    async #pendingSet(sessionId: number, turnId: number, loopId: number): Promise<CompletionEvidence> {
        const pending: CompletionEvidence["pending"] = [];
        // {§loop-completion} — all held work shares one durable projection.
        const held = await this.#db.loop_live_obligations.get<{ streams: 0 | 1; sessions: 0 | 1; messages: 0 | 1 }>({ loop_id: loopId });
        if (held === undefined) throw new Error(`loop ${loopId} does not exist`);
        if (held.streams === 1) pending.push("streams");
        if (held.sessions === 1) pending.push("sessions");
        if (held.messages === 1) pending.push("messages");
        const boundaries = await this.#nextPacketBoundaries(sessionId, turnId);
        const receipts = [...new Set(boundaries.operations
            .filter(({ op }) => op !== "KILL")
            .map((row) => LogEntryProjection.leaf(row)))];
        if (boundaries.streamTerminations.length > 0) receipts.push("stream completion");
        if (receipts.length > 0) pending.push("receipts");
        // A failed stream result is still owed to the model before ordinary completion.
        if (boundaries.streamTerminations.some(({ closeStatus }) => closeStatus >= 400)) pending.push("failed-stream-results");
        if (boundaries.childTerminations) pending.push("session-results");
        return { pending, receipts };
    }

    // {§loop-completion}: completion and an empty wait use the same execution evidence.
    async #nextPacketBoundaries(sessionId: number, turnId: number): Promise<PacketBoundaries> {
        const [turnBoundaries, streamTerminations, childTermination] = await Promise.all([
            this.#db.engine_turn_packet_boundaries.all<{ op: string; tx: string | null }>({ turn_id: turnId }),
            this.#db.engine_session_has_undelivered_stream_term
                .all<{ closeStatus: number }>({ session_id: sessionId }),
            this.#db.engine_session_has_undelivered_child_term
                .get<{ pending: number }>({ session_id: sessionId }),
        ]);
        return {
            operations: turnBoundaries,
            streamTerminations,
            childTerminations: childTermination !== undefined,
        };
    }

    // {§loop-completion}: fresh failures precede automatic parking and completion.
    async #unobservedFailureCount(turnId: number): Promise<number> {
        const row = await this.#db.engine_turn_failure_count.get<{ count: number }>({ turn_id: turnId });
        return row!.count;
    }

    // {§loop-completion}: retrievals land next turn; only held work permits parking.
    async hasLiveWork(loopId: number): Promise<boolean> {
        const held = await this.#db.loop_live_obligations.get<{ streams: 0 | 1; sessions: 0 | 1; messages: 0 | 1 }>({ loop_id: loopId });
        return held !== undefined && (held.streams === 1 || held.sessions === 1 || held.messages === 1);
    }

    async #runLogCuration(
        statement: KillStatement,
        ctx: PlurnkSchemeContext,
        admittedMaxId: number | undefined,
    ): Promise<LogCurationOutcome> {
        const addressedScheme = schemeNameOf(statement.target);
        if (addressedScheme !== null && addressedScheme !== "log") {
            return {
                result: Dispatcher.#failure(
                    "operation-not-implemented",
                    501,
                    `Scheme '${addressedScheme}' does not implement ${statement.op}.`,
                    {},
                    {
                        scheme: addressedScheme,
                        operation: statement.op,
                        retryable: false,
                    },
                ),
                plan: null,
            };
        }
        const registered = this.#schemes.get("log");
        const handler = registered !== undefined && Dispatcher.#curates(registered) ? registered : undefined;
        const manifest = this.#schemes.manifestFor("log");
        if (handler === undefined || manifest === undefined) {
            throw new Error("the core log curation owner is not registered");
        }
        const maxId = admittedMaxId ?? (await this.#db.engine_log_selection_high_water.get<{ max_id: number }>({
            session_id: ctx.sessionId,
        }))?.max_id;
        if (maxId === undefined) {
            throw new Error(`log selection boundary could not be resolved for session ${ctx.sessionId}`);
        }
        const schemeCtx = new SchemeCtxImpl(ctx, "log", manifest, this.#liveSubscriptions, { });
        const outcome = await handler.curate(statement, schemeCtx, maxId);
        return { result: Results.assert(outcome.result), plan: outcome.plan };
    }

    // {§proposal}/{§send} — native dispositions park; other 202 results propose.
    // {§proposal} — an accepted proposal runs its scheme's effect; an accepted admission
    // ({§membership-auto-add}) admits the files the read reached and runs that read or find again, and the
    // operation's own result is what the row records.
    async #applyProposal(
        context: DispatchContext, schemeCtx: PlurnkSchemeContext, result: DispatchResult, resolution: AppliedProposalResolution, logEntryId: number,
    ): Promise<ProposalSettlement> {
        const { statement, workspaceId, sessionId, loopId, turnId } = context;
        const admission = AmbientMembers.admissionOf(result);
        if (admission === null || (statement.op !== "READ" && statement.op !== "FIND")) {
            return this.#proposals.sessionApply(statement, result, resolution, { workspaceId, sessionId, loopId, turnId, logEntryId, resources: schemeCtx.resources });
        }
        if (resolution.decision !== "accept") return { resolution };
        // What the members scope refuses stays unadmitted, and the operation run again misses it as a non-member.
        if (schemeCtx.ambientMembers !== undefined) await schemeCtx.ambientMembers.admit(admission);
        const rerun = await this.#fitResult(context, statement, await this.#dataRun.run(schemeNameOf(statement.target), statement, schemeCtx));
        // {§proposal-projection} — the accepted row is composed from `resolution.result`: the operation's own
        // payload rides there, and a failed run again is the applied result as it stands.
        const { status: _status, problem: _problem, error: _error, ...payload } = rerun as Record<string, unknown>;
        return { resolution: { ...resolution, result: payload }, applied: rerun };
    }

    static #isProposal(statement: PlurnkStatement, result: DispatchResult): boolean {
        if (result.status !== 202) return false;
        return !TurnDisposition.is(statement);
    }

    // Normalize a parsed target for log storage. Bare paths and `file:///...`
    // inputs collapse to scheme=null in log target metadata because both render
    // as bare paths. Addressable file entries separately persist under the
    // reserved `file` identity scheme ({§db-migrations}).
    #extractTarget(path: ParsedPath | null, workspaceId: number): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        query: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, query: null, fragment: null };
        // `local` (bare path) carries no URL parts — store the raw text as the pathname for the log record, scheme=null.
        if (path.kind === "local") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: PathSyntax.decodeParens(path.raw), query: null, fragment: path.fragment ?? null }; // {§path-syntax} {§op-shapes}
        if (path.scheme === "file") {
            const pathname = FileAddress.pathname(path);
            // An invalid URL has no resolved identity; retain the refused input alongside its failure.
            if (typeof pathname !== "string") return { ...path };
            return { scheme: null, username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: path.fragment };
        }
        const scheme = path.scheme;
        // The registered scheme owns authority disposition. Namespace authority
        // is path syntax; resource and owner authorities remain explicit in the
        // durable operation evidence.
        const routedScheme = schemeNameOf(path);
        const manifest = routedScheme === null
            ? undefined
            : this.#schemes.manifestAt(routedScheme, path, workspaceId);
        const foldNs = scheme !== null
            && manifest !== undefined
            && (manifest.authority ?? "namespace") === "namespace";
        return {
            scheme, username: path.username, password: path.password,
            hostname: foldNs ? null : path.hostname, port: foldNs ? null : path.port,
            pathname: PathSyntax.decodeParens(foldNs ? foldAuthorityIntoPath(path.hostname, path.pathname) : path.pathname), // {§path-syntax}
            query: path.query, fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
