import type { SchemeManifest, PlurnkSchemeContext, LoopFlags } from "../core/scheme-types.ts";
import { DEFAULT_LOOP_FLAGS } from "../core/scheme-types.ts";
import type { PrepMethod } from "../core/Db.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult, ReadResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import EntryCrud from "./_entry-crud.ts";
import EntrySend from "./_entry-send.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import Owner from "../core/Owner.ts";
import type { EditStatement, ReadStatement, SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-grammar";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";

// A loop cancelled outside the worker names that act as state before preserving the
// model's last words. NULL terminated_by = the model's own terminal, including an
// already-drained join; its message is the result.
export const markTerminal = (terminatedBy: string | null, message: string | null): string | null => {
    if (terminatedBy === "cancel") return `[ cancelled from outside the worker ]${message === null ? "" : ` ${message}`}`;
    return message;
};

// worker:// — THE knowledgebase scheme (#527) plus inter-worker CONTROL (irc=SEND; WORK/FORK are
// Dispatcher.#handleWorkerControl). The authority names the OWNER ({§worker-authority-carving}):
//   worker:///plan.md          — the COMMONS, the shared blackboard, the encouraged default
//   worker://~/draft.md        — the calling worker's own private space
//   worker://<name>/result.md  — a named worker's space, ancestry-gated read (owner + ancestors)
//   worker://plurnk/docs/x.md  — the kernel's published surface, world-readable
// Writes are self-and-commons only ({§worker-write-scoping}): a named authority is read-only to
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
        scope: "workspace",
        writableBy: ["model", "client", "plurnk"], // the kernel authors worker://plurnk/ (docs); write-scoping still gates principals
        volatile: false,
        modelVisible: true,
        folderScopes: true,
        example: "<<EDIT(worker:///plan.md):- [ ] investigate the timeout:EDIT",
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
        const named = await (ctx.db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, name: authority });
        if (named === undefined) return null;
        if (named.id === ctx.workerId) return { ownerId: named.id, writable: true }; // naming yourself IS ~
        if (authority === "plurnk") return { ownerId: named.id, writable: false };  // the kernel's published surface
        const permitted = await (ctx.db.owner_is_ancestor_or_self as PrepMethod).get<{ permitted: number }>({ owner_id: named.id, reader_id: ctx.workerId });
        return permitted === undefined ? null : { ownerId: named.id, writable: false };
    }

    // Hand the statement to the shared entry helpers authority-stripped: the owner rides the
    // resolved owner_id, the storage pathname is the bare entry path — never authority-folded.
    static #stripAuthority<T extends { target: ParsedPath | null }>(statement: T): T {
        const t = statement.target;
        if (t === null || t.kind !== "url") return statement;
        return { ...statement, target: { ...t, hostname: null } };
    }

    async edit(statement: EditStatement, ctx: CoreSchemeCallContext): Promise<EditResult & { error?: string }> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, entryId: null, channel: null, error: "worker:// requires a worker target" };
        const entryPath = Worker.#entryPath(statement.target);

        // The worker ENTITY (path-absent worker://<name>) is not EDITable — EDIT is entry only
        // (grammar 0.74.55): WORK(worker://<name>) spawns a worker; FORK(worker://<name>) forks a branch.
        if (entryPath === "") return { status: 400, entryId: null, channel: null, error: "worker:// entity is not editable — WORK(worker://<name>) to spawn a worker, FORK(worker://<name>) to fork a branch" };

        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) return { status: 404, entryId: null, channel: null, error: `worker://${authority} not found` };
        if (!resolved.writable) return { status: 403, entryId: null, channel: null, error: "a named worker's space is read-only — write to worker:///... (the commons) or worker://~/... (your own)" };
        return EntryOps.editWorkspaceEntry(Worker.#stripAuthority(statement), core, Worker.manifest, resolved.ownerId);
    }

    // KILL an ENTRY (path present). Same write-scoping as EDIT: self + commons only. The
    // path-ABSENT KILL form is worker cancellation, handled in Dispatcher.#handleKill.
    async killEntry(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<{ status: number; error?: string }> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, error: "worker:// requires a worker target" };
        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) return { status: 404, error: `worker://${authority} not found` };
        if (!resolved.writable) return { status: 403, error: "a named worker's space is read-only — KILL entries in worker:///... (the commons) or worker://~/... (your own)" };
        return EntryOps.deleteWorkspaceEntry(Worker.#stripAuthority(statement), core, Worker.manifest, resolved.ownerId);
    }

    async read(statement: ReadStatement, ctx: CoreSchemeCallContext): Promise<ReadResult> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, content: null, mimetype: null, channel: null };
        const entryPath = Worker.#entryPath(statement.target);
        // Path-absent READ(worker://<name>) COLLECTS the worker's deliverable (§worker-scheme-collect, pull side):
        // its latest loop's terminal message — the SEND[200] result, or an abandonment reason. A worker
        // still running hasn't delivered yet → 425 steers the model to park until it does (the
        // same deliverable the wake/collect-delta will push). The pull complements the push; neither is lost.
        if (entryPath === "") {
            if (authority === "" || authority === "~") return { status: 400, content: null, mimetype: null, channel: null }; // collect names a WORKER
            const row = await (core.db.worker_deliverable_by_name as PrepMethod).get<{ status: number; terminal_message: string | null; terminated_by: string | null }>({ workspace_id: core.workspaceId, name: authority });
            if (row === undefined) return { status: 404, content: `worker://${authority} not found in this workspace`, mimetype: "text/markdown", channel: null };
            // §join-blocking-collect (#354) — a still-running worker is a BLOCKING JOIN: the READ
            // arms the join (awaitWorker), and the turn's bare SEND[102] parks until the worker delivers.
            // The model doesn't drive the park — the engine does (a blocking read() hiding the scheduler).
            if (!Worker.#TERMINAL_LOOP.has(row.status)) return { status: 425, content: `[ worker '${authority}' is still running — parking this turn until it delivers its result ]`, mimetype: "text/markdown", channel: null, awaitWorker: authority };
            return { status: 200, content: markTerminal(row.terminated_by, row.terminal_message) ?? `[ worker '${authority}' concluded with no deliverable (status ${row.status}) ]`, mimetype: "text/markdown", channel: null };
        }
        // Path-present: an entry read — commons / own / ancestry-gated named space.
        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) return { status: 404, content: null, mimetype: null, channel: null };
        return EntryOps.readWorkspaceEntry(Worker.#stripAuthority(statement), core, Worker.manifest, resolved.ownerId);
    }

    // Terminal loop statuses (§lifecycle-terms) — a loop here has DELIVERED; anything else is still running.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    // FIND draws from the resolved principal's space alone: worker:///** the commons,
    // worker://~/** your own, worker://<name>/** a named space (ancestry-gated like READ).
    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        // A regex-kind target (#pattern#flags) has no authority slot — it draws from the commons.
        if (statement.target !== null && statement.target.kind === "regex") {
            return EntryFind.findWorkspaceEntries(statement, core, Worker.manifest, await Owner.commonsId(core.db, core.workspaceId));
        }
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
        const resolved = await Worker.#resolveAuthority(authority, core);
        if (resolved === null) return { status: 404, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [] };
        const found = await EntryFind.findWorkspaceEntries(Worker.#stripAuthority(statement), core, Worker.manifest, resolved.ownerId);
        // The catalog renders the empty-authority form; a non-empty queried authority re-applies —
        // in results AND the serialized content the packet renders — so every path the model sees
        // is the address it typed (worker://~/x, worker://beta/x).
        if (authority === "") return found;
        const reface = (p: string): string => p.replace(/^worker:\/\/\//, `worker://${authority}/`);
        const results = found.results.map((r) => ({ ...r, path: reface(r.path) }));
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

    async send(statement: SendStatement, ctx: CoreSchemeCallContext): Promise<{ status: number; error?: string }> {
        const core = this.coreContext(ctx);
        const authority = Worker.#authority(statement.target);
        if (authority === null) return { status: 400, error: "worker:// irc requires a worker (worker://<name>)" };
        // An ENTRY-path SEND is the entry-SEND law (410 deletes, 499 cancels, else 501) on the
        // resolved principal; write-scoping holds — a named space takes no 410.
        if (Worker.#entryPath(statement.target) !== "") {
            const resolved = await Worker.#resolveAuthority(authority, core);
            if (resolved === null) return { status: 404, error: `worker://${authority} not found` };
            if (!resolved.writable && statement.signal === 410) return { status: 403, error: "a named worker's space is read-only" };
            return EntrySend.sendToWorkspaceEntry(Worker.#stripAuthority(statement), core, Worker.manifest.name, resolved.ownerId);
        }
        if (authority === "") return { status: 400, error: "worker:// irc requires a worker (worker://<name>)" };
        if (core.injectWorker === undefined) throw new Error("run.send: injectWorker capability absent");
        let workerId = core.workerId;
        if (authority !== "~") {
            const row = await (core.db.worker_resolve_by_name as PrepMethod).get<{ id: number }>({ workspace_id: core.workspaceId, name: authority });
            if (row === undefined) return { status: 404, error: `worker://${authority} not found in this workspace` };
            workerId = row.id;
        }
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        // §worker-delegation-inherits-flags — an irc that RESUMES a parked loop keeps that loop's
        // own flags (inject ignores these there); a fresh loop raised by the message acts on
        // the sender's behalf and carries the sender's authority.
        const row = await (core.db.engine_get_loop_flags as PrepMethod).get<{ flags: string }>({ loop_id: core.loopId });
        const flags = row === undefined ? undefined : { ...DEFAULT_LOOP_FLAGS, ...(JSON.parse(row.flags) as Partial<LoopFlags>) };
        await core.injectWorker({ workspaceId: core.workspaceId, workerId, prompt, flags });
        return { status: 200 };
    }
}
