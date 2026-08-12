import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import LoopFlagsReader from "../core/LoopFlagsReader.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import Owner from "../core/Owner.ts";
import type { EditStatement, SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-contracts";
import type {
    ChannelProducerResult,
    RepresentationPreparationRequest,
    RepresentationPreparationResult,
    SchemeCtx,
} from "@plurnk/plurnk-schemes";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreEntryAddress, CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResultBase } from "../core/results.ts";
import BranchReceipt from "../core/BranchReceipt.ts";
import TerminalResult from "../core/TerminalResult.ts";
import WorkerControlAddress from "../core/WorkerControlAddress.ts";

// {§worker-scheme} — worker:// is the knowledgebase plus inter-worker control (irc=SEND; WORK/FORK are
// Dispatcher.#handleWorkerControl). The authority names the OWNER ({§worker-authority-carving}):
//   worker:///notes.md         — the COMMONS, a shared blackboard
//   worker://~/draft.md        — the calling worker's own private space
//   worker://<name>/result.md  — a named worker's space, ancestry-gated read (owner + ancestors)
//   worker://plurnk/docs/x.md  — the kernel's published surface, world-readable
// Writes are own-space-and-commons only ({§worker-write-scoping}): a named authority is read-only to
// the model, so nothing worker-authored can ever land under another principal — worker://plurnk/
// included, which is what makes the kernel's surface the trust boundary with no guard to forget.
// Path-absent forms are control on the worker-as-actor: READ collects the deliverable, SEND ircs;
// WORK spawns / FORK forks (Dispatcher); EDIT on the bare entity is rejected.
export default class Worker extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "worker",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client", "plurnk"], // the kernel authors worker://plurnk/ (docs); write-scoping still gates principals
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        example: "## EDIT0 (worker:///notes.md)\nInvestigation notes.",
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

    // {§worker-authority-carving} — resolve the authority to the owning principal. Empty = the
    // commons (writable — the blackboard default); `~` = the caller (writable — own space); the
    // kernel's surface is world-READABLE; any other name is ancestry-gated read ({§worker-read-scope}:
    // the reader is the owner or an ancestor — oversight flows down the tree). Unknown name or
    // unpermitted reader → null → 404, no existence leak. Writability is the {§worker-write-scoping}
    // law: only `~` and the commons take model writes; owner_id is engine-stamped, never model-set.
    static async #resolveAuthority(authority: string, ctx: PlurnkSchemeContext): Promise<{ ownerId: number; writable: boolean } | null> {
        if (authority === "") return { ownerId: await Owner.commonsId(ctx.db, ctx.workspaceId), writable: true };
        if (authority === "~") return { ownerId: ctx.workerId, writable: true };
        const named = await ctx.db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: authority });
        if (named === undefined) return null;
        if (named.id === ctx.workerId) return { ownerId: named.id, writable: true }; // a literal own name resolves to the same owner without becoming a sigil
        if (authority === "plurnk") return { ownerId: named.id, writable: false };  // the kernel's published surface
        const permitted = await ctx.db.owner_is_ancestor_or_self.get<{ permitted: number }>({ owner_id: named.id, reader_id: ctx.workerId });
        return permitted === undefined ? null : { ownerId: named.id, writable: false };
    }

    // Hand the statement to the shared entry helpers authority-stripped: the owner rides the
    // resolved owner_id, the storage pathname is the bare entry path — never authority-folded.
    static #stripAuthority<T extends { target: ParsedPath | null }>(statement: T): T {
        const t = statement.target;
        if (t === null || t.kind !== "url") return statement;
        return { ...statement, target: { ...t, hostname: null } };
    }

    async resolveEntryAddress(
        target: ParsedPath,
        ctx: CoreSchemeCallContext,
    ): Promise<CoreEntryAddress | SchemeResultBase | null> {
        const authority = Worker.#authority(target);
        if (authority === null) return null;
        if (target.kind === "url" && target.pathname === "") {
            if (authority === "" || authority === "~") {
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
                target.username !== null
                || target.password !== null
                || target.port !== null
                || target.query !== null
                || target.headers !== undefined
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
            const named = await this.coreContext(ctx).db.worker_resolve_by_name.get<{ id: number }>({
                workspace_id: ctx.workspaceId,
                name: authority,
            });
            return named === undefined
                ? Results.failure(
                    "scheme:worker",
                    "worker-not-found",
                    404,
                    `Worker '${authority}' does not exist in this workspace.`,
                    {},
                    { worker: authority, retryable: false },
                )
                : { pathname: "", ownerId: named.id };
        }
        const pathname = Worker.#entryPath(target);
        const resolved = await Worker.#resolveAuthority(authority, this.coreContext(ctx));
        return resolved === null
            ? Results.failure(
                "scheme:worker",
                "worker-not-found",
                404,
                `Worker '${authority}' does not exist in this workspace.`,
                {},
                { worker: authority, retryable: false },
            )
            : { pathname, ownerId: resolved.ownerId };
    }

    async prepareRepresentation(
        request: RepresentationPreparationRequest,
        ctx: SchemeCtx,
    ): Promise<RepresentationPreparationResult> {
        if (request.target.kind !== "url" || request.target.pathname !== "") {
            return { status: 200 };
        }
        const authority = Worker.#authority(request.target);
        if (authority === null || authority === "" || authority === "~") {
            throw new Error("Worker deliverable preparation received an unresolved address.");
        }
        const core = this.coreContext(ctx);
        const row = await core.db.worker_deliverable_by_name.get<{
            worker_id: number;
            status: number;
            terminal_result: string | null;
            terminated_by: string | null;
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
            const detail = `Worker '${authority}' is still running and has no deliverable yet.`;
            return Results.failure(
                "scheme:worker",
                "worker-still-running",
                425,
                detail,
                { awaitWorker: authority },
                {
                    worker: authority,
                    recovery: "Continue once; the engine will wait for the worker's deliverable.",
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
            receipt: await BranchReceipt.render(core.db, row.worker_id),
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

    async editBatch(statements: readonly EditStatement[], ctx: CoreSchemeCallContext): Promise<EditResult> {
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

        // The worker ENTITY (path-absent worker://<name>) is not EDITable — EDIT is entry only
        // WORK on worker://<name> spawns a worker; FORK on that address forks a branch.
        if (entryPath === "") {
            return failure(
                "worker-entity-not-editable",
                400,
                "A worker entity is not an editable entry.",
                {
                    recovery: "Use WORK or FORK to create a worker.",
                    retryable: false,
                },
            );
        }

        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) {
            return failure(
                "worker-not-found",
                404,
                `Worker '${authority}' does not exist in this workspace.`,
                {
                    worker: authority,
                    retryable: false,
                },
            );
        }
        if (!resolved.writable) {
            return failure(
                "worker-space-read-only",
                403,
                `Worker '${authority}' has a read-only space.`,
                {
                    worker: authority,
                    recovery: "Write to the commons or the current worker's own space.",
                    retryable: false,
                },
            );
        }
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
        return EntryOps.editWorkspaceEntryBatch(statements.map((candidate) => Worker.#stripAuthority(candidate)), core, Worker.manifest, resolved.ownerId);
    }

    async edit(statement: EditStatement, ctx: CoreSchemeCallContext): Promise<EditResult> {
        return this.editBatch([statement], ctx);
    }

    // KILL an ENTRY (path present). Same write-scoping as EDIT: own space + commons only. The
    // path-ABSENT KILL form is worker cancellation, handled in Dispatcher.#handleKill.
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
        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) {
            return Results.failure(
                "scheme:worker",
                "worker-not-found",
                404,
                `Worker '${authority}' does not exist.`,
                {},
                {
                    worker: authority,
                    retryable: false,
                },
            );
        }
        if (!resolved.writable) {
            return Results.failure(
                "scheme:worker",
                "worker-space-read-only",
                403,
                `Worker '${authority}' has a read-only space.`,
                {},
                {
                    worker: authority,
                    recovery: "KILL entries in the commons or the current worker's own space.",
                    retryable: false,
                },
            );
        }
        return EntryOps.deleteWorkspaceEntry(Worker.#stripAuthority(statement), core, Worker.manifest, resolved.ownerId);
    }

    // Terminal loop statuses ({§lifecycle-terms}) — a loop here has DELIVERED; anything else is still running.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    // FIND draws from the resolved principal's space alone: worker:///** the commons,
    // worker://~/** your own, worker://<name>/** a named space (ancestry-gated like READ).
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) {
            return Results.failure("scheme:worker", "worker-target-required", 400, "FIND requires a worker:// target.", {
                content: null, mimetype: null, results: [], itemsTokenTotal: 0, returnedItemsTokenTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                recovery: "Provide the worker target.",
                retryable: false,
            }) as FindResult;
        }
        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) {
            return Results.failure("scheme:worker", "worker-not-found", 404, `Worker '${authority}' does not exist in this workspace.`, {
                content: null, mimetype: null, results: [], itemsTokenTotal: 0, returnedItemsTokenTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }, {
                worker: authority,
                retryable: false,
            }) as FindResult;
        }
        const found = await EntryFind.findWorkspaceEntries(Worker.#stripAuthority(statement), core, Worker.manifest, {
            ownerId: resolved.ownerId,
        });
        // The catalog renders the empty-authority form; a non-empty queried authority re-applies —
        // in results AND the serialized content the packet renders — so every path the model sees
        // is the address it typed (worker://~/x, worker://beta/x).
        if (authority === "") return found;
        const reface = (p: string): string => p.replace(/^worker:\/\/\//, `worker://${authority}/`);
        const results = found.results.map((r) => typeof r.path === "string" ? { ...r, path: reface(r.path) } : r);
        const content = found.content === null ? null : found.content.replaceAll("worker:///", `worker://${authority}/`);
        return { ...found, results, content };
    }

    // The entry-copy seam ({§worker-authority-carving}) — pathname-keyed, COMMONS-scoped: the
    // dispatcher refuses a non-empty authority upstream, so these faces only ever see worker:///….
    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        return EntryCrud.readEntry(pathname, this.coreContext(ctx), Worker.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return EntryCrud.writeEntry(pathname, entry, this.coreContext(ctx), Worker.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return EntryCrud.deleteEntry(pathname, this.coreContext(ctx), Worker.manifest.name);
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
        // An ENTRY-path SEND is the entry-SEND law (410 deletes, 499 cancels, else 501) on the
        // resolved principal; write-scoping holds — a named space takes no 410.
        if (Worker.#entryPath(statement.target) !== "") {
            const resolved = await Worker.#resolveAuthority(authority, core);
            if (resolved === null) {
                return Results.failure(
                    "scheme:worker",
                    "worker-not-found",
                    404,
                    `Worker '${authority}' does not exist in this workspace.`,
                    {},
                    {
                        worker: authority,
                        retryable: false,
                    },
                );
            }
            if (!resolved.writable && statement.signal === 410) {
                return Results.failure(
                    "scheme:worker",
                    "worker-space-read-only",
                    403,
                    `Worker '${authority}' has a read-only space.`,
                    {},
                    {
                        worker: authority,
                        retryable: false,
                    },
                );
            }
            return EntrySend.sendToWorkspaceEntry(Worker.#stripAuthority(statement), core, Worker.manifest.name, resolved.ownerId);
        }
        const address = WorkerControlAddress.resolve(statement.target, "SEND");
        if (!address.ok) return address.result;
        const controlAuthority = address.authority;
        if (core.injectWorker === undefined) throw new Error("worker.send: injectWorker capability absent");
        let workerId = core.workerId;
        if (controlAuthority !== "~") {
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
            workerId = row.id;
        }
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        // {§worker-delegation-inherits-flags} — an irc that RESUMES a parked loop keeps that loop's
        // own flags (inject ignores these there); a fresh loop raised by the message acts on
        // the sender's behalf and carries the sender's authority.
        const flags = await LoopFlagsReader.read(core.db, core.loopId);
        await core.injectWorker({ workspaceId: core.workspaceId, workerId, prompt, flags });
        return { status: 200 };
    }
}
