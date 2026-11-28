import {
    lifecycleOfLoopStatus,
    normalizeExteriorActorProfiles,
    selectSessionLoop,
    Validator,
    type ApplicationInboxMessage,
    type ApplicationLoopProjection,
    type ApplicationSessionKind,
    type ApplicationStream,
    type ApplicationStreamChannel,
    type ClientInteractionProjection,
    type FindStatement,
    type KillStatement,
    type LogEntryWire,
    type ParsedPath,
} from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import type {
    EntryAddress,
    ResolvedEditStatement,
} from "@plurnk/plurnk-schemes";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";
import {
    CoreSchemeAdapterBase,
    type CoreRepresentationProvider,
    type CoreRepresentationResolution,
    type CoreSchemeCallContext,
} from "../core/CoreSchemeServices.ts";
import type { Db } from "../core/Db.ts";
import MessageResources from "../core/MessageResources.ts";
import { missDetail, missExtensions, renderAddress } from "../core/plurnk-uri.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../core/scheme-types.ts";
import ToolResources from "../core/ToolResources.ts";
import EntryCrud, { type DeleteEntryResult, type EntryData, type ReadEntryResult, type WriteEntryResult } from "./_entry-crud.ts";
import EntryFind, { type FindResult } from "./_entry-find.ts";
import EntryManifest from "./_entry-manifest.ts";
import EntryOps, { type EditResult } from "./_entry-ops.ts";

interface StoredSessionRow {
    readonly id: number;
    readonly name: string;
    readonly workspace_id: number;
    readonly created_at: string;
    readonly origin: "model" | "_plurnk";
    readonly owner: string;
    readonly parentSessionId: number | null;
    readonly archived_at: string | null;
    readonly title?: string | null;
    readonly persona?: string | null;
    readonly kind: ApplicationSessionKind;
    readonly loopObservations: string;
}

interface StoredLoopRow {
    readonly id: number;
    readonly sessionId: number;
    readonly sequence: number;
    readonly status: number;
    readonly prompt: string;
    readonly promptSource: string | null;
    readonly claimedAt: string | null;
    readonly terminatedAt: string | null;
    readonly terminalResult: string | null;
    readonly packetCount: number;
    readonly waitUntil: number | null;
    readonly invocationSessionId: number | null;
    readonly invocation: string | null;
}

interface StoredOpenStreamRow {
    readonly id: number;
    readonly entry_id: number;
    readonly session_id: number;
    readonly scheme: string;
    readonly authority: string;
    readonly pathname: string;
    readonly source: string | null;
    readonly opened_at: string;
    readonly channel: string | null;
    readonly state: ApplicationStreamChannel["state"] | null;
    readonly mimetype: string | null;
}

interface StoredProposalRow {
    readonly logEntryId: number;
    readonly sessionId: number;
    readonly session: string;
    readonly loopId: number;
    readonly turnId: number;
    readonly loopSeq: number;
    readonly turnSeq: number;
    readonly sequence: number;
    readonly op: string;
    readonly scheme: string | null;
    readonly hostname: string | null;
    readonly port: number | null;
    readonly pathname: string | null;
    readonly owner: string;
    readonly attrs: string;
}

interface StoredInteractionRow {
    readonly interactionId: number;
    readonly sessionId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly recipient: string;
    readonly request: string;
}

interface StoredLogEntryRow {
    readonly id: number;
    readonly session_id: number;
    readonly session_name: string;
    readonly loop_id: number;
    readonly loop_seq: number;
    readonly turn_id: number;
    readonly turn_seq: number;
    readonly sequence: number;
    readonly at: string;
    readonly origin: string;
    readonly source: string | null;
    readonly op: string | null;
    readonly signal: string | null;
    readonly scheme: string | null;
    readonly username: string | null;
    readonly password: string | null;
    readonly hostname: string | null;
    readonly port: number | null;
    readonly pathname: string | null;
    readonly query: string | null;
    readonly fragment: string | null;
    readonly lineMarker: string | null;
    readonly tx: string | null;
    readonly mimetype_tx: string;
    readonly rx: string | null;
    readonly mimetype_rx: string;
    readonly status_rx: number;
    readonly weight: number;
    readonly attrs: string | null;
    readonly state: LogEntryWire["state"];
    readonly reasoning: string | null;
    readonly reasoning_model_call_id: number | null;
    readonly reasoning_request_sequence: number | null;
    readonly invocation: string | null;
    readonly answering: string | null;
    readonly replied_to_sources?: string | null;
    readonly replied_to_actors?: string | null;
}

// {§tools-resource-materialization} Reference entries, consolidated global guidance, and session status/recent JSON projections live under plurnk:/// and mcp:///.
export default class Plurnk extends CoreSchemeAdapterBase {
    readonly #manifest: SchemeManifest;
    readonly resolveCoreRepresentation?: CoreRepresentationProvider["resolveCoreRepresentation"];

    constructor(name: "plurnk" | "mcp" = "plurnk") {
        super();
        this.#manifest = {
            name,
            authority: "namespace",
            channels: { readable: "text/markdown" },
            defaultChannel: "body",
            category: "data",
            writableBy: ["_plurnk"],
            volatile: false,
            modelVisible: true,
            folderScopes: true,
            textEditScopes: true,
        };
        if (name === "plurnk") {
            this.resolveCoreRepresentation = (target, ctx) => this.#resolveCoreRepresentation(target, ctx);
        }
    }

    get manifest(): SchemeManifest {
        return this.#manifest;
    }

    #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== this.#manifest.name) return null;
        return target.hostname ?? "";
    }

    static #entryPath(target: ParsedPath | null): string {
        if (target === null || target.kind !== "url") return "";
        const p = target.pathname ?? "";
        return p === "/" ? "" : p;
    }

    static #isSessionJsonPath(pathname: string): pathname is "/status.json" | "/recent.json" {
        return pathname === "/status.json" || pathname === "/recent.json";
    }

    #entryAddress(authority: string, pathname: string, access: "read" | "write"): EntryAddress | SchemeResultBase {
        if (authority !== "") return Results.failure(
            `scheme:${this.#manifest.name}`, `${this.#manifest.name}-authority-unsupported`, 400,
            `A ${this.#manifest.name}:/// address takes no authority.`, {},
            { recovery: `Use ${this.#manifest.name}:///path.`, retryable: false },
        );
        if (access === "write" && pathname === "") return Results.failure(
            `scheme:${this.#manifest.name}`, `${this.#manifest.name}-entity-not-editable`, 400,
            `A ${this.#manifest.name} entity is not an editable entry.`, {},
            { recovery: `edit requires an entry path, such as ${this.#manifest.name}:///example.md.`, retryable: false },
        );
        if (access === "write" && this.#manifest.name === "plurnk" && Plurnk.#isSessionJsonPath(pathname)) {
            return Results.failure(
                "scheme:plurnk", "plurnk-entry-computed", 400,
                `plurnk://${pathname} is computed and is not an editable entry.`, {},
                { retryable: false },
            );
        }
        return { authority: "", pathname };
    }

    async resolveEntryAddress(
        target: ParsedPath,
        _ctx: CoreSchemeCallContext,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | SchemeResultBase | null> {
        const authority = this.#authority(target);
        return authority === null ? null
            : this.#entryAddress(authority, Plurnk.#entryPath(target), access);
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext): Promise<EditResult> {
        const precondition = SchemeCtxImpl.editPreconditionOf(ctx);
        const statement = statements[0];
        if (statement === undefined) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                "edit-empty",
                400,
                "edit requires at least one statement.",
                { entryId: null, channel: null },
                { recovery: "Add an edit statement or omit the operation.", retryable: false },
            );
        }
        const core = this.coreContext(ctx);
        const authority = this.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                `${this.#manifest.name}-target-required`,
                400,
                `edit requires a ${this.#manifest.name}:/// target.`,
                { entryId: null, channel: null },
                { recovery: `Provide the ${this.#manifest.name} target.`, retryable: false },
            );
        }
        const entryPath = Plurnk.#entryPath(statement.target);
        const resolved = this.#entryAddress(authority, entryPath, "write");
        if ("status" in resolved) return { ...resolved, entryId: null, channel: null };
        return EntryOps.editWorkspaceEntryBatch(
            statements,
            core,
            this.#manifest,
            precondition,
        );
    }

    async killEntry(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = this.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                `scheme:${this.#manifest.name}`,
                `${this.#manifest.name}-target-required`,
                400,
                `kill requires a ${this.#manifest.name} target.`,
                {},
                { recovery: `Provide the ${this.#manifest.name} target.`, retryable: false },
            );
        }
        const resolved = this.#entryAddress(authority, Plurnk.#entryPath(statement.target), "write");
        if ("status" in resolved) return resolved;
        return EntryOps.deleteWorkspaceEntry(statement, core, this.#manifest);
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const authority = this.#authority(statement.target);
        if (authority === null) {
            return Results.failure(`scheme:${this.#manifest.name}`, `${this.#manifest.name}-target-required`, 400, `find requires a ${this.#manifest.name}:/// target.`, {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: `Provide the ${this.#manifest.name} target.`,
                retryable: false,
            });
        }
        if (authority !== "") {
            return Results.failure(`scheme:${this.#manifest.name}`, `${this.#manifest.name}-authority-unsupported`, 400, `A ${this.#manifest.name}:/// address takes no authority.`, {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: `Use ${this.#manifest.name}:///path.`,
                retryable: false,
            });
        }
        return EntryFind.findWorkspaceEntries(statement, core, this.#manifest, { authority: "" });
    }

    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        if (this.#manifest.name === "plurnk" && Plurnk.#isSessionJsonPath(pathname)) {
            const computed = await this.#resolveSessionJson(pathname, core);
            if ("result" in computed) {
                return Results.assert({ ...computed.result, entry: null });
            }
            return { status: 200, entry: computed.representation };
        }
        return "entries" in ctx
            ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, this.#manifest.name);
    }

    async #resolveCoreRepresentation(
        target: ParsedPath | null,
        ctx: CoreSchemeCallContext,
    ): Promise<CoreRepresentationResolution> {
        if (target === null) {
            return {
                result: Results.failure(
                    "scheme:plurnk",
                    "read-target-required",
                    400,
                    "read requires a target path.",
                    { content: null, mimetype: null, channel: null },
                    { recovery: "Provide the entry target.", retryable: false },
                ),
            };
        }
        const authority = this.#authority(target);
        if (authority === null) {
            return {
                result: Results.failure(
                    "scheme:plurnk",
                    "plurnk-target-required",
                    400,
                    "read requires a plurnk:/// target.",
                    { content: null, mimetype: null, channel: null },
                    { recovery: "Provide the plurnk:/// target.", retryable: false },
                ),
            };
        }
        if (authority !== "") {
            return {
                result: Results.failure(
                    "scheme:plurnk",
                    "plurnk-authority-unsupported",
                    400,
                    "A plurnk:/// address takes no authority.",
                    { content: null, mimetype: null, channel: null },
                    { recovery: "Use plurnk:///path.", retryable: false },
                ),
            };
        }
        const core = this.coreContext(ctx);
        const pathname = Plurnk.#entryPath(target);
        if (Plurnk.#isSessionJsonPath(pathname)) {
            return this.#resolveSessionJson(pathname, core);
        }
        const path = EntryManifest.toPath("plurnk", "", pathname, null);
        const visible = core.referenceVisibility !== undefined ? await core.referenceVisibility() : undefined;
        const stored = visible !== undefined && !visible(pathname)
            ? { status: 404, entry: null }
            : await EntryCrud.readEntry({ authority: "", pathname }, core, "plurnk");
        if (stored.entry === null) {
            return {
                result: Results.failure(
                    "scheme:plurnk",
                    "entry-not-found",
                    404,
                    missDetail("plurnk", path),
                    { content: null, mimetype: null, channel: null },
                    missExtensions("plurnk", path),
                ),
            };
        }
        let representation = stored.entry;
        if (visible !== undefined && (pathname.endsWith(".md") || pathname.endsWith(".json"))) {
            const channels = Object.fromEntries(await Promise.all(
                Object.entries(representation.channels).map(async ([name, ch]) => [
                    name,
                    { ...ch, content: await ToolResources.filterDocumentForVisibleTools(pathname, ch.content, visible) },
                ]),
            ));
            representation = { ...representation, channels };
        }
        return { representation };
    }

    async #resolveSessionJson(
        pathname: "/status.json" | "/recent.json",
        core: PlurnkSchemeContext,
    ): Promise<CoreRepresentationResolution> {
        const boundSessionId = core.client !== undefined ? core.client.contextSessionId : core.sessionId;
        if (boundSessionId === null) {
            return {
                result: Results.failure(
                    "scheme:plurnk",
                    "session-unaddressed",
                    404,
                    `No session is bound for plurnk://${pathname}.`,
                    { content: null, mimetype: null, channel: null },
                    { target: `plurnk://${pathname}`, retryable: false },
                ),
            };
        }
        const sessionRow = await core.db.envelope_get_session_by_id.get<StoredSessionRow>({ id: boundSessionId });
        if (sessionRow === undefined || sessionRow.workspace_id !== core.workspaceId) {
            return {
                result: Results.failure(
                    "scheme:plurnk",
                    "session-not-found",
                    404,
                    `Session ${boundSessionId} does not exist in workspace ${core.workspaceId}.`,
                    { content: null, mimetype: null, channel: null },
                    { workspaceId: core.workspaceId, sessionId: boundSessionId, retryable: false },
                ),
            };
        }
        const payload = pathname === "/status.json"
            ? await Plurnk.#buildStatusPayload(core.db, core.workspaceId, boundSessionId, sessionRow)
            : await Plurnk.#buildRecentPayload(core.db, core.workspaceId, boundSessionId);
        return {
            representation: {
                channels: {
                    body: {
                        content: JSON.stringify(payload, null, 2),
                        mimetype: "application/json",
                        state: "static",
                    },
                },
            },
        };
    }

    static async #buildStatusPayload(
        db: Db,
        workspaceId: number,
        sessionId: number,
        sessionRow: StoredSessionRow,
    ): Promise<Record<string, unknown>> {
        const { workspace_id: _workspaceId, created_at: createdAt, archived_at: archivedAt, loopObservations, title, persona, ...sessionRest } = sessionRow;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- {§db-migrations}: aggregated loopObservations JSON from envelope_get_session_by_id
        const observedLoops = JSON.parse(loopObservations) as Array<{
            status: number;
            sequence: number;
            terminatedAt: string | null;
        }>;
        const session = {
            ...sessionRest,
            createdAt,
            archivedAt,
            ...(typeof title === "string" ? { title } : {}),
            ...(typeof persona === "string" ? { persona } : {}),
            lifecycle: lifecycleOfLoopStatus(selectSessionLoop(observedLoops)?.status),
        };
        const isModelSession = sessionRow.origin === "model";
        const [loopRows, inbox, openStreams, proposalRows, interactionRows] = await Promise.all([
            db.application_list_session_loops.all<StoredLoopRow>({ session_id: sessionId }),
            isModelSession
                ? MessageResources.inbox(db, { workspaceId, sessionId })
                : Promise.resolve([] as ApplicationInboxMessage[]),
            Plurnk.#readOpenStreams(db, sessionId),
            db.proposal_list_pending.all<StoredProposalRow>({ workspace_id: workspaceId }),
            db.client_interaction_list.all<StoredInteractionRow>({ workspace_id: workspaceId }),
        ]);
        const loops: ApplicationLoopProjection[] = loopRows.map((row) => ({
            id: row.id,
            sessionId: row.sessionId,
            sequence: row.sequence,
            status: row.status,
            prompt: row.prompt,
            promptSource: row.promptSource,
            claimedAt: row.claimedAt,
            terminatedAt: row.terminatedAt,
            packetCount: row.packetCount,
            waitUntil: row.waitUntil,
            invocation: row.invocation === null || row.invocationSessionId === null
                ? null
                : { sessionId: row.invocationSessionId, address: row.invocation },
            terminalResult: row.terminalResult === null ? null : Results.fromRow(row.terminalResult),
        }));
        const activeLoopIds = new Set(loops.filter((l) => l.terminatedAt === null).map((l) => l.id));
        const pendingProposals = proposalRows
            .filter((row) => row.sessionId === sessionId && activeLoopIds.has(row.loopId))
            .map((row) => ({
                logEntryId: row.logEntryId,
                sessionId: row.sessionId,
                session: row.session,
                loopId: row.loopId,
                turnId: row.turnId,
                coordinate: `${row.loopSeq}/${row.turnSeq}/${row.sequence}`,
                op: row.op.toLowerCase(),
                target: {
                    scheme: row.scheme,
                    authority: row.hostname === null
                        ? null
                        : row.port === null
                            ? row.hostname
                            : `${row.hostname}:${row.port}`,
                    pathname: row.pathname,
                },
                owner: row.owner,
                attrs: Plurnk.#parseJsonOrNull(row.attrs) ?? {},
            }));
        const pendingInteractions: ClientInteractionProjection[] = interactionRows
            .filter((row) => row.sessionId === sessionId && activeLoopIds.has(row.loopId))
            .map((row) => Validator.assertClientInteractionProjection({
                interactionId: row.interactionId,
                sessionId: row.sessionId,
                loopId: row.loopId,
                turnId: row.turnId,
                recipient: row.recipient,
                request: Validator.assertClientInteractionRequest(JSON.parse(row.request)),
            }));
        return {
            workspaceId,
            sessionId,
            isModelSession,
            session,
            loops,
            inbox,
            openStreams,
            pendingProposals,
            pendingInteractions,
        };
    }

    static async #readOpenStreams(db: Db, sessionId: number): Promise<ApplicationStream[]> {
        const rows = await db.session_open_streams.all<StoredOpenStreamRow>({ session_id: sessionId });
        const opened = new Map<number, { readonly row: StoredOpenStreamRow; readonly channels: ApplicationStreamChannel[] }>();
        for (const row of rows) {
            const stream = opened.get(row.id) ?? { row, channels: [] };
            opened.set(row.id, stream);
            if (row.channel !== null && row.state !== null && row.mimetype !== null) {
                stream.channels.push({ channel: row.channel, state: row.state, mimetype: row.mimetype });
            }
        }
        const out: ApplicationStream[] = [];
        for (const { row, channels } of opened.values()) {
            const match = row.source === null ? null : /^log:\/\/\/(\d+)\/(\d+)\/(\d+)\/([^/]+)$/u.exec(row.source);
            const openedAtCoord: Pick<ApplicationStream, "op" | "loopSeq" | "turnSeq" | "sequence"> = match === null
                ? {}
                : {
                    ...(match[4] ? { op: match[4] } : {}),
                    loopSeq: Number(match[1]),
                    turnSeq: Number(match[2]),
                    sequence: Number(match[3]),
                };
            let aside: string | undefined;
            if (
                openedAtCoord.loopSeq !== undefined
                && openedAtCoord.turnSeq !== undefined
                && openedAtCoord.sequence !== undefined
            ) {
                const asideRow = await db.log_entry_aside_at_coordinate.get<{ aside: string | null }>({
                    session_id: row.session_id,
                    loop_seq: openedAtCoord.loopSeq,
                    turn_seq: openedAtCoord.turnSeq,
                    sequence: openedAtCoord.sequence,
                });
                if (typeof asideRow?.aside === "string" && asideRow.aside.trim().length > 0) {
                    aside = asideRow.aside.trim();
                }
            }
            out.push({
                entryId: row.entry_id,
                sessionId: row.session_id,
                target: renderAddress({ scheme: row.scheme, authority: row.authority, pathname: row.pathname }),
                openedAt: row.opened_at,
                ...openedAtCoord,
                ...(aside !== undefined ? { aside } : {}),
                channels,
            });
        }
        return out;
    }

    static async #buildRecentPayload(
        db: Db,
        workspaceId: number,
        sessionId: number,
    ): Promise<Record<string, unknown>> {
        const limit = Math.min(50, Knob.integer("PLURNK_SERVICE_LOG_READ_MAX", 1));
        const runtimeRow = await db.runtime_session_get.get<{ id: number }>({ workspace_id: workspaceId });
        const runtimeSessionId = runtimeRow?.id ?? null;
        const queryRecent = (targetSessionId: number) =>
            db.log_entries_recent.all<StoredLogEntryRow>({
                session_id: targetSessionId,
                loop_id: null,
                turn_id: null,
                since_id: null,
                before_id: null,
                loop_seq: null,
                before_loop_seq: null,
                after_loop_seq: null,
                last_loops: null,
                turn_seq: null,
                sequence: null,
                limit,
            });
        const [sessionRows, runtimeRows] = await Promise.all([
            queryRecent(sessionId),
            runtimeSessionId !== null && runtimeSessionId !== sessionId
                ? queryRecent(runtimeSessionId)
                : Promise.resolve([] as StoredLogEntryRow[]),
        ]);
        return {
            workspaceId,
            sessionId,
            entries: sessionRows.map((row) => Plurnk.#hydrateLogRow(row)),
            runtimeEntries: runtimeRows.map((row) => Plurnk.#hydrateLogRow(row)),
        };
    }

    static #parseJsonOrNull(value: string | null): unknown {
        if (value === null || value === "") return null;
        return JSON.parse(value);
    }

    static #hydrateLogRow(row: StoredLogEntryRow): LogEntryWire & { readonly coordinate: string | null } {
        const parsedReplied = Plurnk.#parseJsonOrNull(row.replied_to_sources ?? null);
        const repliedSources = Array.isArray(parsedReplied)
            ? parsedReplied.filter((item): item is string => typeof item === "string" && item.length > 0)
            : [];
        const repliedActors = normalizeExteriorActorProfiles(Plurnk.#parseJsonOrNull(row.replied_to_actors ?? null));
        const coordinate = typeof row.op === "string" && row.op.length > 0
            ? `log:///${row.loop_seq}/${row.turn_seq}/${row.sequence}/${row.op.toLowerCase()}`
            : null;
        return {
            id: row.id,
            sessionId: row.session_id,
            sessionName: row.session_name,
            loopId: row.loop_id,
            loopSeq: row.loop_seq,
            turnId: row.turn_id,
            turnSeq: row.turn_seq,
            sequence: row.sequence,
            at: row.at,
            origin: row.origin,
            source: row.source,
            op: row.op,
            signal: Plurnk.#parseJsonOrNull(row.signal),
            scheme: row.scheme,
            username: row.username,
            password: row.password,
            hostname: row.hostname,
            port: row.port,
            pathname: row.pathname,
            query: row.query,
            fragment: row.fragment,
            lineMarker: Plurnk.#parseJsonOrNull(row.lineMarker),
            tx: Plurnk.#parseJsonOrNull(row.tx),
            mimetypeTx: row.mimetype_tx,
            rx: Plurnk.#parseJsonOrNull(row.rx),
            mimetypeRx: row.mimetype_rx,
            statusRx: row.status_rx,
            weight: row.weight,
            attrs: Plurnk.#parseJsonOrNull(row.attrs),
            state: row.state,
            ...(row.reasoning === null ? {} : {
                reasoning: row.reasoning,
                ...(row.reasoning_model_call_id === null ? {} : { reasoningModelCallId: row.reasoning_model_call_id }),
                ...(row.reasoning_request_sequence === null ? {} : { reasoningRequestSequence: row.reasoning_request_sequence }),
            }),
            ...(row.invocation === null ? {} : { invocation: row.invocation }),
            ...(row.answering === null ? {} : { answering: row.answering }),
            ...(repliedSources.length > 0 ? { repliedToSources: repliedSources } : {}),
            ...(repliedActors.length > 0 ? { repliedToActors: repliedActors } : {}),
            coordinate,
        };
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.write(pathname, entry)
            : EntryCrud.writeEntry(
                { authority: "", pathname },
                entry,
                this.coreContext(ctx),
                this.#manifest.name,
            );
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.delete(pathname)
            : EntryCrud.deleteEntry(
                { authority: "", pathname },
                this.coreContext(ctx),
                this.#manifest.name,
            );
    }
}
