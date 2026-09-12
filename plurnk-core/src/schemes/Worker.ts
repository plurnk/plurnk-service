import type { SchemeManifest } from "../core/scheme-types.ts";
import LoopPolicyReader from "../core/LoopPolicyReader.ts";
import { taskTiming } from "../core/LoopLifecycle.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import type { SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type {
    ChannelProducerResult,
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
import WorkerControlAddress from "../core/WorkerControlAddress.ts";
import SchemeCtxImpl from "../core/caps/SchemeCtxImpl.ts";

// {§worker-scheme} Named and shared scratch are workspace resources; pathless
// addresses target actors through the ordinary delegation and messaging lifecycle.
export default class Worker extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "worker",
        authority: "resource",
        // {§readable-channel} — `readable` is the source's derived projection, never written.
        channels: { body: "text/markdown", readable: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "_plurnk", "plugin"],
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        textEditScopes: true,
    };

    // The authority from a worker:// target — "" for the empty (commons) form; null when the
    // target isn't a worker:// url at all.
    static #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "worker") return null;
        return target.hostname ?? "";
    }

    // The entry path within the space — the target's pathname; "" / "/" mean no entry (the
    // worker-as-actor / control form).
    static #entryPath(target: ParsedPath | null): string {
        if (target === null || target.kind !== "url") return "";
        const p = target.pathname ?? "";
        return p === "/" ? "" : p;
    }

    static #entryAddress(authority: string, pathname: string, access: "read" | "write"): EntryAddress | SchemeResultBase {
        if (access === "write" && pathname === "") return Results.failure(
            "scheme:worker", "worker-entity-not-editable", 400,
            "A worker entity is not an editable entry.", {},
            { recovery: "EDIT requires an entry path, such as worker:///notes.md.", retryable: false },
        );
        return { authority, pathname };
    }

    async resolveEntryAddress(
        target: ParsedPath,
        _ctx: CoreSchemeCallContext,
        access: "read" | "write" = "read",
    ): Promise<EntryAddress | SchemeResultBase | null> {
        const authority = Worker.#authority(target);
        return authority === null ? null
            : Worker.#entryAddress(authority, Worker.#entryPath(target), access);
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.metadata !== null) {
            return Results.failure(
                "scheme:worker",
                "metadata-unsupported",
                400,
                "Worker resources do not accept the {metadata} modifier.",
                {},
                { retryable: false },
            );
        }
        if (request.target.kind !== "url" || request.target.pathname !== "") {
            return { status: 200 };
        }
        const authority = Worker.#authority(request.target);
        if (authority === null || authority === "") {
            return Results.failure(
                "scheme:worker",
                "named-worker-required",
                400,
                "A worker deliverable READ requires a named worker.",
                {},
                {
                    recovery: "Address the worker by name.",
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
                "scheme:worker",
                "control-address-invalid",
                400,
                "READ requires an authority-only worker:// control address.",
                {},
                {
                    operation: "READ",
                    recovery: "Provide one worker authority and remove every other URI component.",
                    retryable: false,
                },
            );
        }
        const core = this.coreContext(ctx);
        const row = await core.db.worker_deliverable_by_name.get<{
            id: number;
            worker_id: number;
            status: number;
            terminal_result: string | null;
            terminated_by: string | null;
            scheduled_at: number | null;
            repeat_interval_ms: number | null;
            recurrence_root_loop_id: number | null;
        }>({ workspace_id: core.workspaceId, name: authority });
        if (row === undefined) {
            return Results.failure(
                "scheme:worker",
                "worker-not-found",
                404,
                `Worker '${authority}' does not exist in this workspace.`,
                {},
                { worker: authority, retryable: false },
            );
        }
        if (!Worker.#TERMINAL_LOOP.has(row.status)) {
            const detail = `Worker '${authority}' has unfinished work (status ${row.status}).`;
            return Results.failure(
                "scheme:worker",
                "worker-unfinished",
                425,
                detail,
                { loopId: row.id, ...taskTiming(row) },
                {
                    worker: authority,
                    retryable: false,
                },
            );
        }
        if (row.terminal_result === null) {
            throw new Error(`terminal worker '${authority}' has no terminal result`);
        }
        const exact = TerminalResult.parse(
            row.terminal_result,
            `terminal worker '${authority}'`,
        );
        const presentation = TerminalResult.present(exact, {
            terminatedBy: row.terminated_by,
            fallback: `[ worker '${authority}' concluded with no deliverable (status ${exact.status}) ]`,
        });
        const projectionFields = new Set([
            "content",
            "mimetype",
            "channel",
            "startLine",
            "region",
            "matches",
            "range",
        ]);
        const producerResult = Results.assertChannelProducerResult(Object.fromEntries(
            Object.entries(exact).filter(([field]) => !projectionFields.has(field)),
        ) as unknown as ChannelProducerResult);
        const written = await ctx.entries.write(request.pathname, {
            channels: {
                body: {
                    content: presentation?.content ?? "",
                    mimetype: presentation?.mimetype ?? "text/markdown",
                    producerResult,
                },
            },
        });
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
            "scheme:worker",
            code,
            status,
            detail,
            { entryId: null, channel: null },
            extensions,
        ) as EditResult;
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
        const authority = Worker.#authority(statement.target);
        if (authority === null) {
            return failure(
                "worker-target-required",
                400,
                "EDIT requires a worker:// target.",
                {
                    recovery: "Provide the worker target.",
                    retryable: false,
                },
            );
        }
        const entryPath = Worker.#entryPath(statement.target);

        const resolved = Worker.#entryAddress(authority, entryPath, "write");
        if ("status" in resolved) return { ...resolved, entryId: null, channel: null };
        if (statements.some((candidate) => Worker.#authority(candidate.target) !== authority)) {
            return failure(
                "edit-batch-mismatch",
                400,
                "One EDIT batch cannot span multiple worker spaces.",
                {
                    recovery: "Use a separate EDIT batch for each worker space.",
                    retryable: false,
                },
            );
        }
        return EntryOps.editWorkspaceEntryBatch(
            statements,
            core,
            Worker.manifest,
            precondition,
        );
    }

    async edit(statement: ResolvedEditStatement, ctx: CoreSchemeCallContext): Promise<EditResult> {
        return this.editBatch([statement], ctx);
    }

    // Pathless KILL is worker cancellation; an entry path is ordinary scratch deletion.
    async killEntry(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                "scheme:worker",
                "worker-target-required",
                400,
                "KILL requires a worker target.",
                {},
                {
                    recovery: "Provide the worker target.",
                    retryable: false,
                },
            );
        }
        const resolved = Worker.#entryAddress(authority, Worker.#entryPath(statement.target), "write");
        if ("status" in resolved) return resolved;
        return EntryOps.deleteWorkspaceEntry(statement, core, Worker.manifest);
    }

    // Terminal loop statuses ({§lifecycle-terms}); all other tasks remain unfinished.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    // {§worker-read-scope} The requested namespace scopes discovery, not access.
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) {
            return Results.failure("scheme:worker", "worker-target-required", 400, "FIND requires a worker:// target.", {
                content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: "Provide the worker target.",
                retryable: false,
            }) as FindResult;
        }
        return EntryFind.findWorkspaceEntries(statement, core, Worker.manifest, { authority });
    }

    // Bound contexts carry the exact resource authority through transfers.
    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, Worker.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.write(pathname, entry)
            : EntryCrud.writeEntry(
                { authority: "", pathname },
                entry,
                this.coreContext(ctx),
                Worker.manifest.name,
            );
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return "entries" in ctx
            ? ctx.entries.delete(pathname)
            : EntryCrud.deleteEntry(
                { authority: "", pathname },
                this.coreContext(ctx),
                Worker.manifest.name,
            );
    }

    async send(statement: SendStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) {
            return Results.failure(
                "scheme:worker",
                "worker-target-required",
                400,
                "Directed worker SEND requires a worker target.",
                {},
                {
                    recovery: "Provide the worker target.",
                    retryable: false,
                },
            );
        }
        // An entry is not a message recipient ({§send-dispatch-entry-schemes-501}).
        if (Worker.#entryPath(statement.target) !== "") {
            return EntrySend.sendToWorkspaceEntry(statement, core, Worker.manifest);
        }
        const address = WorkerControlAddress.resolve(statement.target, "SEND");
        if (!address.ok) return address.result;
        const marks = statement.lineMarker?.marks;
        const [delay, interval] = marks ?? [];
        const maxMinutes = Math.floor((8.64e15 - Date.now()) / 60_000);
        if (marks !== undefined && (marks.length < 1 || marks.length > 2
            || delay === undefined || !Number.isSafeInteger(delay) || delay < 0
            || (interval !== undefined && (!Number.isSafeInteger(interval) || interval <= 0))
            || delay + (interval ?? 0) > maxMinutes)) {
            return Results.failure(
                "scheme:worker", "invalid-schedule", 400,
                "Worker SEND timing is <delay[,interval]> in whole minutes: delay >= 0, interval > 0, within the supported date range.",
                {}, { retryable: false },
            );
        }
        const controlAuthority = address.authority;
        if (core.injectWorker === undefined) throw new Error("worker.send: injectWorker capability absent");
        const row = await core.db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: core.workspaceId, name: controlAuthority });
        if (row === undefined) {
            return Results.failure(
                "scheme:worker",
                "worker-not-found",
                404,
                `Worker '${controlAuthority}' does not exist in this workspace.`,
                {},
                {
                    worker: controlAuthority,
                    retryable: false,
                },
            );
        }
        const workerId = row.id;
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        // {§worker-delegation-inherits-policy} Only fresh loops inherit proposal
        // disposition; resumed loops retain their immutable policy.
        const freshLoopPolicy = await LoopPolicyReader.read(core.db, core.loopId);
        const accepted = await core.injectWorker({
            workspaceId: core.workspaceId,
            workerId,
            sourceLoopId: core.loopId,
            prompt,
            freshLoopPolicy,
            ...(delay === undefined ? {} : { schedule: {
                delayMs: delay * 60_000,
                ...(interval === undefined ? {} : { intervalMs: interval * 60_000 }),
            } }),
        });
        return { status: 200, ...(delay === undefined ? {} : accepted) };
    }
}
