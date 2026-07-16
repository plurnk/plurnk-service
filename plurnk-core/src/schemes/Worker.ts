import type { SchemeManifest, PlurnkSchemeContext, LoopFlags } from "../core/scheme-types.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { PrepMethod } from "../core/Db.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult, ReadResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
import type { EditStatement, ReadStatement, SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-grammar";

// #379 (owner ruling) — a loop the ENGINE concluded (∅-collapse) or the CLIENT killed (cancel)
// must not present its last words as a deliverable: run42's workers parked on nothing, the
// collapse concluded them, and the parent COLLECTed 'Standing by for user input' as a status-200
// stage result — nine blind re-spawns. The marker names the act as STATE; the model's words
// follow unrewritten. NULL terminated_by = the model's own terminal — the message IS the result.
export const markTerminal = (terminatedBy: string | null, message: string | null): string | null => {
    if (terminatedBy === "collapse") return `[ concluded on ∅-collapse — waited on nothing; no result was produced ]${message === null ? "" : ` ${message}`}`;
    if (terminatedBy === "cancel") return `[ cancelled from outside the run ]${message === null ? "" : ` ${message}`}`;
    return message;
};

// worker:// — the run scheme: inter-run CONTROL (irc=SEND; WORK=spawn, FORK=fork is Dispatcher.#handleWorkerControl)
// AND run-scoped STORAGE (§run-scheme). The run is always the AUTHORITY: worker://<name>/<path> is
// entry <path> owned by run <name>; `worker://self` is the current run, empty authority is invalid.
// Worker is excluded from #extractTarget's authority-fold (Engine) so the authority stays the run
// name, never folded.
//   - path present → storage: READ any run's entry by address (cross-run read ok); EDIT self
//     only (cross-run write → 403 — a run reads a sister's notes, never writes them).
//   - path absent  → control on the run-as-actor: WORK spawns / FORK forks (Engine), SEND ircs, READ
//     collects the deliverable; EDIT on the bare entity is rejected (the entity is not an entry).
export default class Worker {
    static manifest: SchemeManifest = {
        name: "worker",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "worker",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        example: "<<EDIT(worker://self/todo.md):- [ ] investigate the timeout:EDIT",
    };

    // The run name from a worker:// target's authority (hostname). "self" = the current run;
    // "" (empty authority) is invalid; null when the target isn't a worker:// url.
    static #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "worker") return null;
        return target.hostname ?? "";
    }

    // The entry path within the run — the target's pathname; "" / "/" mean no entry (the
    // run-as-actor / control form).
    static #entryPath(target: ParsedPath | null): string {
        if (target === null || target.kind !== "url") return "";
        const p = target.pathname ?? "";
        return p === "/" ? "" : p;
    }

    // The acting run's own name — for self-resolution and the cross-run-write gate.
    static async #selfName(ctx: PlurnkSchemeContext): Promise<string> {
        const row = await (ctx.db.worker_name_by_id as PrepMethod).get<{ name: string }>({ worker_id: ctx.workerId });
        if (row === undefined) throw new Error("run: acting run has no name");
        return row.name;
    }

    // Clone a statement with its target's authority (hostname) set to the resolved owner, so
    // the shared entry helper folds it into the storage path (/<owner>/<entry>).
    static #withOwner<T extends { target: ParsedPath | null }>(statement: T, owner: string): T {
        const t = statement.target;
        if (t === null || t.kind !== "url") return statement;
        return { ...statement, target: { ...t, hostname: owner } };
    }

    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<EditResult | { status: number; error?: string; body?: string }> {
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, error: "worker:// requires a run target" };
        const entryPath = Worker.#entryPath(statement.target);

        // The run ENTITY (path-absent worker://<name>) is not EDITable — EDIT is file/entry only
        // (grammar 0.74.55): WORK(worker://<name>) spawns a worker; FORK(worker://<name>) forks a named branch.
        if (entryPath === "") return { status: 400, error: "worker:// entity is not editable — WORK(worker://<name>) to spawn a worker, FORK(worker://<name>) to fork a branch" };

        // Storage: write a run-scope entry. Self only — cross-run write is denied (§run-scheme).
        if (authority === "") return { status: 400, error: "worker:// requires a run name or 'self' (worker://self/<path>)" };
        const self = await Worker.#selfName(ctx);
        const owner = authority === "self" ? self : authority;
        if (owner !== self) return { status: 403, error: "worker:// write is self-only — read a sister's notes, never write them" };
        return EntryOps.editWorkspaceEntry(Worker.#withOwner(statement, owner), ctx, Worker.manifest);
    }

    // KILL a run-scope scratch ENTRY (path present). Self-only — deleting a sister's notes
    // is a cross-run write, denied like EDIT (§run-scheme). The path-ABSENT KILL form is run
    // cancellation, handled in Dispatcher.#handleKill (it routes only entry-path KILLs here).
    async deleteEntry(statement: KillStatement, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, error: "worker:// requires a run target" };
        if (authority === "") return { status: 400, error: "worker:// requires a run name or 'self' (worker://self/<path>)" };
        const self = await Worker.#selfName(ctx);
        const owner = authority === "self" ? self : authority;
        if (owner !== self) return { status: 403, error: "worker:// kill is self-only — read a sister's notes, never delete them" };
        return EntryOps.deleteWorkspaceEntry(Worker.#withOwner(statement, owner), ctx, Worker.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, content: null, mimetype: null, channel: null };
        if (authority === "") return { status: 400, content: null, mimetype: null, channel: null };  // empty-authority worker:/// is invalid
        const entryPath = Worker.#entryPath(statement.target);
        // Path-absent READ(worker://<name>) COLLECTS the run's deliverable (§run-scheme-collect, pull side):
        // its latest loop's terminal message — the SEND[200] result, or an abandonment reason. A worker
        // still running hasn't delivered yet → 425 steers the model to park until it does (the
        // same deliverable the wake/collect-delta will push). The pull complements the push; neither is lost.
        if (entryPath === "") {
            const owner = authority === "self" ? await Worker.#selfName(ctx) : authority;
            const row = await (ctx.db.worker_deliverable_by_name as PrepMethod).get<{ status: number; terminal_message: string | null; terminated_by: string | null }>({ workspace_id: ctx.workspaceId, name: owner });
            if (row === undefined) return { status: 404, content: `worker://${owner} not found in this workspace`, mimetype: "text/markdown", channel: null };
            // §join-blocking-collect (#354) — a still-running worker is a BLOCKING JOIN: the READ
            // arms the join (awaitWorker), and the turn's bare SEND[102] parks until the worker delivers.
            // The model doesn't drive the park — the engine does (a blocking read() hiding the scheduler).
            if (!Worker.#TERMINAL_LOOP.has(row.status)) return { status: 425, content: `[ worker '${owner}' is still running — parking this turn until it delivers its result ]`, mimetype: "text/markdown", channel: null, awaitWorker: owner };
            return { status: 200, content: markTerminal(row.terminated_by, row.terminal_message) ?? `[ worker '${owner}' concluded with no deliverable (status ${row.status}) ]`, mimetype: "text/markdown", channel: null };
        }
        // Path-present: cross-run scratch READ — resolve self, fold the owner into the storage path.
        const owner = authority === "self" ? await Worker.#selfName(ctx) : authority;
        return EntryOps.readWorkspaceEntry(Worker.#withOwner(statement, owner), ctx, Worker.manifest);
    }

    // Terminal loop statuses (§lifecycle-terms) — a loop here has DELIVERED; anything else is still running.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    // §run-scheme — FIND a run's scratch. `worker://self/**` is self; `worker://<name>/**` a sister
    // (cross-run READ is allowed, so cross-run FIND is too). Resolve the owner and fold it into
    // the scope pathname (`/<owner>/<rest>`) so EntryFind draws from that run's partition alone.
    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
        if (authority === "") return { status: 400, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
        const owner = authority === "self" ? await Worker.#selfName(ctx) : authority;
        const t = statement.target;
        const folded = t !== null && t.kind === "url"
            ? { ...statement, target: { ...t, hostname: null, pathname: foldAuthorityIntoPath(owner, t.pathname) } }
            : statement;
        return EntryFind.findWorkspaceEntries(folded, ctx, Worker.manifest);
    }

    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, error: "worker:// irc requires a run (worker://<name>)" };
        if (authority === "") return { status: 400, error: "worker:// irc requires a run name or 'self' (worker://<name>)" };
        if (ctx.injectWorker === undefined) throw new Error("run.send: injectWorker capability absent");
        let workerId = ctx.workerId;
        if (authority !== "self") {
            const row = await (ctx.db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, name: authority });
            if (row === undefined) return { status: 404, error: `worker://${authority} not found in this workspace` };
            workerId = row.id;
        }
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        // §run-delegation-inherits-flags — an irc that RESUMES a parked loop keeps that loop's
        // own flags (inject ignores these there); a fresh loop raised by the message acts on
        // the sender's behalf and carries the sender's authority.
        const row = await (ctx.db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: ctx.loopId });
        const flags = row === undefined ? undefined : { ...DEFAULT_LOOP_FLAGS, ...(JSON.parse(row.flags) as Partial<LoopFlags>) };
        await ctx.injectWorker({ workspaceId: ctx.workspaceId, workerId, prompt, flags });
        return { status: 200 };
    }
}
