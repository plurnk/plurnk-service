import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { PrepMethod } from "../core/Db.ts";
import RunCap from "../core/run-cap.ts";
import EntryOps from "./_entry-ops.ts";
import type { EditResult, ReadResult } from "./_entry-ops.ts";
import EntryFind from "./_entry-find.ts";
import type { FindResult } from "./_entry-find.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
import type { EditStatement, ReadStatement, SendStatement, FindStatement, KillStatement, ParsedPath } from "@plurnk/plurnk-grammar";

// run:// — the run scheme: inter-run CONTROL (spawn/irc; COPY=fork is Engine.#handleCopy) AND
// run-scoped STORAGE (§run-scheme). The run is always the AUTHORITY: run://<name>/<path> is
// entry <path> owned by run <name>; run:/// (empty authority) is self. Run is excluded from
// #extractTarget's authority-fold (Engine) so the empty-authority=self signal survives.
//   - path present → storage: READ any run's entry by address (cross-run read ok); EDIT self
//     only (cross-run write → 403 — a run reads a sister's notes, never writes them).
//   - path absent  → control on the run-as-actor: EDIT spawns a sister, SEND ircs one.
export default class Run {
    static manifest: SchemeManifest = {
        name: "run",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "run",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        example: "<<EDIT(run:///todo.md):- [ ] investigate the timeout:EDIT",
    };

    // The run name from a run:// target's authority (hostname). "" = self (empty authority);
    // null when the target isn't a run:// url.
    static #authority(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "run") return null;
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
        const row = await (ctx.db.run_name_by_id as PrepMethod).get<{ name: string }>({ run_id: ctx.runId });
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
        const authority = Run.#authority(statement.target);
        if (authority === null) return { status: 400, error: "run:// requires a run target" };
        const entryPath = Run.#entryPath(statement.target);

        if (entryPath === "") {
            // Control: spawn the sister named by the authority. Self cannot be spawned.
            if (authority === "" || authority === ".") return { status: 400, error: "run:// spawn cannot target self (run://<name>)" };
            if (ctx.injectRun === undefined) throw new Error("run.edit: injectRun capability absent");
            const denied = await RunCap.deny(ctx.db, ctx.sessionId);
            if (denied !== null) return denied;
            const row = await (ctx.db.fork_insert_run as PrepMethod).get<{ id: number }>({
                session_id: ctx.sessionId, name: authority, parent_run_id: ctx.runId, origin: ctx.writer,
            });
            if (row === undefined) throw new Error("run.edit: run insert returned no row");
            await ctx.injectRun({ sessionId: ctx.sessionId, runId: row.id, prompt: statement.body ?? "" });
            return { status: 200, body: authority };
        }

        // Storage: write a run-scope entry. Self only — cross-run write is denied (§run-scheme).
        const self = await Run.#selfName(ctx);
        const owner = authority === "" ? self : authority;
        if (owner !== self) return { status: 403, error: "run:// write is self-only — read a sister's notes, never write them" };
        return EntryOps.editSessionEntry(Run.#withOwner(statement, owner), ctx, Run.manifest);
    }

    // KILL a run-scope scratch ENTRY (path present). Self-only — deleting a sister's notes
    // is a cross-run write, denied like EDIT (§run-scheme). The path-ABSENT KILL form is run
    // cancellation, handled in Engine.#handleKill (it routes only entry-path KILLs here).
    async deleteEntry(statement: KillStatement, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        const authority = Run.#authority(statement.target);
        if (authority === null) return { status: 400, error: "run:// requires a run target" };
        const self = await Run.#selfName(ctx);
        const owner = authority === "" ? self : authority;
        if (owner !== self) return { status: 403, error: "run:// kill is self-only — read a sister's notes, never delete them" };
        return EntryOps.deleteSessionEntry(Run.#withOwner(statement, owner), ctx, Run.manifest);
    }

    async read(statement: ReadStatement, ctx: PlurnkSchemeContext): Promise<ReadResult> {
        const authority = Run.#authority(statement.target);
        if (authority === null) return { status: 400, content: null, mimetype: null, channel: null };
        const entryPath = Run.#entryPath(statement.target);
        if (entryPath === "") return { status: 400, content: null, mimetype: null, channel: null };  // a run is not READable, only its entries
        // Cross-run READ is allowed — resolve self, fold the owner into the storage path.
        const owner = authority === "" ? await Run.#selfName(ctx) : authority;
        return EntryOps.readSessionEntry(Run.#withOwner(statement, owner), ctx, Run.manifest);
    }

    // §run-scheme — FIND a run's scratch. `run:///**` is self; `run://<name>/**` a sister
    // (cross-run READ is allowed, so cross-run FIND is too). Resolve the owner and fold it into
    // the scope pathname (`/<owner>/<rest>`) so EntryFind draws from that run's partition alone.
    async find(statement: FindStatement, ctx: PlurnkSchemeContext): Promise<FindResult> {
        const authority = Run.#authority(statement.target);
        if (authority === null) return { status: 400, content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [] };
        const owner = authority === "" ? await Run.#selfName(ctx) : authority;
        const t = statement.target;
        const folded = t !== null && t.kind === "url"
            ? { ...statement, target: { ...t, hostname: null, pathname: foldAuthorityIntoPath(owner, t.pathname) } }
            : statement;
        return EntryFind.findSessionEntries(folded, ctx, Run.manifest);
    }

    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        const authority = Run.#authority(statement.target);
        if (authority === null) return { status: 400, error: "run:// irc requires a run (run://<name>)" };
        if (ctx.injectRun === undefined) throw new Error("run.send: injectRun capability absent");
        let runId = ctx.runId;
        if (authority !== "" && authority !== ".") {
            const row = await (ctx.db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, name: authority });
            if (row === undefined) return { status: 404, error: `run://${authority} not found in this session` };
            runId = row.id;
        }
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        await ctx.injectRun({ sessionId: ctx.sessionId, runId, prompt });
        return { status: 200 };
    }
}
