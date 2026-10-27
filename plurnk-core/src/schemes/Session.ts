import type { SchemeManifest } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import type { SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type {
    EntryAddress,
    ResolvedEditStatement,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
} from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import TerminalResult from "../core/TerminalResult.ts";
import { loopOutcome } from "../core/LoopOutcome.ts";
import SessionControlAddress from "../core/SessionControlAddress.ts";
import SessionControlHandler from "../core/SessionControlHandler.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";
import { MessageAttachments } from "@plurnk/plurnk-schemes";

// {§session-scheme} Named scratch is a workspace resource; pathless
// addresses target actors through the ordinary delegation and messaging lifecycle.
export default class Session extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "session",
        authority: "resource",
        // {§channel-selection} — `readable` is the source's derived projection, never written.
        channels: { readable: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "_plurnk"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
    };

    // The authority from a session:// target — "" when absent; null when the
    // target isn't a session:// url at all.
    static #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "session") return null;
        return target.hostname ?? "";
    }

    // The entry path within the space — the target's pathname; "" / "/" mean no entry (the
    // session-as-actor / control form).
    static #entryPath(target: ParsedPath | null): string {
        if (target === null || target.kind !== "url") return "";
        const p = target.pathname ?? "";
        return p === "/" ? "" : p;
    }

    static #entryAddress(authority: string, pathname: string, access: "read" | "write"): EntryAddress | SchemeResultBase {
        if (access === "write" && pathname === "") return Results.failure(
            "scheme:session", "session-entity-not-editable", 400,
            "A session entity is not an editable entry.", {},
            { recovery: "EDIT requires an entry path, such as workspace:///example.md.", retryable: false },
        );
        if (authority === "" && pathname !== "") return Results.failure(
            "scheme:session", "named-session-required", 400,
            "A session entry address requires a named session.", {},
            { recovery: "Address the session by name, or use workspace:/// for shared workspace entries.", retryable: false },
        );
        return { authority, pathname };
    }

    async resolveEntryAddress(
        target: ParsedPath,
        _ctx: CoreSchemeCallContext,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | SchemeResultBase | null> {
        const authority = Session.#authority(target);
        return authority === null ? null
            : Session.#entryAddress(authority, Session.#entryPath(target), access);
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.metadata !== null) {
            return Results.failure(
                "scheme:session",
                "metadata-unsupported",
                400,
                "Session resource reads do not accept the [metadata] modifier.",
                {},
                { retryable: false },
            );
        }
        if (request.target.kind !== "url" || request.target.pathname !== "") {
            return { status: 200 };
        }
        const authority = Session.#authority(request.target);
        if (authority === null || authority === "") {
            return Results.failure(
                "scheme:session",
                "named-session-required",
                400,
                "A session deliverable READ requires a named session.",
                {},
                {
                    recovery: "Address the session by name.",
                    retryable: false,
                },
            );
        }
        if (
            request.target.username !== null
            || request.target.password !== null
            || request.target.port !== null
            || request.target.query !== null
        ) {
            return Results.failure(
                "scheme:session",
                "control-address-invalid",
                400,
                "READ requires an authority-only session:// control address.",
                {},
                {
                    operation: "READ",
                    recovery: "Provide one session authority and remove every other URI component.",
                    retryable: false,
                },
            );
        }
        const core = this.coreContext(ctx);
        const row = await core.db.session_collect_loop.get<{ name: string; sequence: number }>({
            workspace_id: core.workspaceId, name: authority,
        });
        if (row === undefined) return Results.failure(
            "scheme:session", "session-not-found", 404,
            `Session '${authority}' has no loop in this workspace.`, {}, { retryable: false },
        );
        // {§session-scheme} the pull mirrors the push: both name the loop's own address.
        const outcome = await loopOutcome(core.db, core.workspaceId, row.name, row.sequence);
        if (outcome === null) return Results.failure(
            "scheme:session", "session-not-found", 404,
            `Session '${authority}' has no loop in this workspace.`, {}, { retryable: false },
        );
        const written = await ctx.entries.write(request.pathname, TerminalResult.representation(outcome.result, outcome.resource, outcome.terminatedBy));
        return Results.isErrorStatus(written.status) ? written : { status: 200 };
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: CoreSchemeCallContext): Promise<EditResult> {
        const precondition = SchemeCtxImpl.editPreconditionOf(ctx);
        const failure = (
            code: string,
            status: number,
            detail: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): EditResult => Results.failure(
            "scheme:session",
            code,
            status,
            detail,
            { entryId: null, channel: null },
            extensions,
        );
        const statement = statements[0];
        if (statement === undefined) {
            return failure(
                "edit-empty",
                400,
                "EDIT requires at least one statement.",
                {
                    recovery: "Add an EDIT statement or omit the operation.",
                    retryable: false,
                },
            );
        }
        const core = this.coreContext(ctx);
        const authority = Session.#authority(statement.target);
        if (authority === null) {
            return failure(
                "session-target-required",
                400,
                "EDIT requires a session:// target.",
                {
                    recovery: "Provide the session target.",
                    retryable: false,
                },
            );
        }
        const entryPath = Session.#entryPath(statement.target);

        const resolved = Session.#entryAddress(authority, entryPath, "write");
        if ("status" in resolved) return { ...resolved, entryId: null, channel: null };
        if (statements.some((candidate) => Session.#authority(candidate.target) !== authority)) {
            return failure(
                "edit-batch-mismatch",
                400,
                "One EDIT batch cannot span multiple session spaces.",
                {
                    recovery: "Use a separate EDIT batch for each session space.",
                    retryable: false,
                },
            );
        }
        return EntryOps.editWorkspaceEntryBatch(
            statements,
            core,
            Session.manifest,
            precondition,
        );
    }

    async edit(statement: ResolvedEditStatement, ctx: CoreSchemeCallContext): Promise<EditResult> {
        return this.editBatch([statement], ctx);
    }

    // Pathless KILL is session cancellation; an entry path is ordinary scratch deletion.
    async killEntry(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = Session.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                "scheme:session",
                "session-target-required",
                400,
                "KILL requires a session target.",
                {},
                {
                    recovery: "Provide the session target.",
                    retryable: false,
                },
            );
        }
        const resolved = Session.#entryAddress(authority, Session.#entryPath(statement.target), "write");
        if ("status" in resolved) return resolved;
        return EntryOps.deleteWorkspaceEntry(statement, core, Session.manifest);
    }

    // {§session-scheme} The requested namespace scopes discovery, not access.
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const authority = Session.#authority(statement.target);
        if (authority === null) {
            return Results.failure("scheme:session", "session-target-required", 400, "FIND requires a session:// target.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: "Provide the session target.",
                retryable: false,
            });
        }
        if (authority === "") {
            return Results.failure("scheme:session", "named-session-required", 400, "A session FIND requires a named session.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: "Address the session by name, or use workspace:/// for shared workspace entries.",
                retryable: false,
            });
        }
        return EntryFind.findWorkspaceEntries(statement, core, Session.manifest, { authority });
    }

    // Bound contexts carry the exact resource authority through transfers.
    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, Session.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.write(pathname, entry)
            : EntryCrud.writeEntry(
                { authority: "", pathname },
                entry,
                this.coreContext(ctx),
                Session.manifest.name,
            );
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.delete(pathname)
            : EntryCrud.deleteEntry(
                { authority: "", pathname },
                this.coreContext(ctx),
                Session.manifest.name,
            );
    }

    async send(statement: SendStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = Session.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                "scheme:session",
                "session-target-required",
                400,
                "Directed session SEND requires a session target.",
                {},
                {
                    recovery: "Provide the session target.",
                    retryable: false,
                },
            );
        }
        // An entry is not a message recipient ({§op-methods-op-dispatch}).
        if (Session.#entryPath(statement.target) !== "") {
            return EntrySend.sendToWorkspaceEntry(statement, core, Session.manifest);
        }
        const address = SessionControlAddress.resolve(statement.target, "SEND");
        if (!address.ok) return address.result;
        // {§send-directed-scope} — a session SEND takes no scope.
        if (statement.lineMarker !== null) {
            return Results.failure("scheme:session", "scope-unsupported", 400, "A session SEND takes no scope.", {}, { retryable: false });
        }
        const controlAuthority = address.authority;
        if (core.injectSession === undefined) throw new Error("session.send: injectSession capability absent");
        const row = await core.db.session_resolve_by_name.get<{ id: number }>({ workspace_id: core.workspaceId, name: controlAuthority });
        if (row === undefined) {
            return Results.failure(
                "scheme:session",
                "session-not-found",
                404,
                `Session '${controlAuthority}' does not exist in this workspace.`,
                {},
                {
                    session: controlAuthority,
                    retryable: false,
                },
            );
        }
        const sessionId = row.id;
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        const captured = await MessageAttachments.capture(statement.metadata, core.resources!, "scheme:session");
        if ("failure" in captured) return captured.failure;
        if (prompt.trim() === "" && captured.attachments.length === 0) {
            return Results.failure(
                "scheme:session", "message-empty", 422,
                "SEND has no message text or attachments.", {}, { retryable: false },
            );
        }
        // {§session-ownership} Messages preserve the receiving session’s owner.
        const opener = SessionControlHandler.opener(core);
        const { message } = await core.injectSession({
            workspaceId: core.workspaceId,
            sessionId,
            sourceLoopId: core.loopId,
            prompt,
            ...(captured.attachments.length === 0 ? {} : { attachments: captured.attachments }),
            ...(opener === undefined ? {} : { opener }),
        });
        return {
            status: 200,
            ...(captured.attachments.length === 0 ? {} : { attachments: MessageAttachments.receipts(captured.attachments) }),
            ...(opener === undefined ? {} : { attrs: { message } }),
        };
    }
}
