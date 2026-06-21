import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { PrepMethod } from "../core/Db.ts";
import RunCap from "../core/run-cap.ts";
import type { EditStatement, SendStatement, ParsedPath } from "@plurnk/plurnk-grammar";

// run:// — the agent-run control scheme (SPEC §machine-processes, §actor-boundary).
// A run:// address targets a sister run in the SAME session; `run:///.` is self.
// Three ops, all riding ctx.injectRun (→ Daemon.inject): EDIT = spawn (a fresh
// sister, the prompt on its first loop), SEND = irc (deliver to an existing
// sister, waking it if idle). COPY = fork lives in Engine.#handleCopy — it must
// copy the log before injecting. The scheme owns no entries: pure run control.
export default class Run {
    // A control scheme — no entry channels. `category` is "data" only because
    // SchemeManifest offers no control/process value; the field is descriptive
    // and read nowhere (raised with plurnk-schemes). writableBy gates who may
    // emit run:// ops (§scheme-surface-writableby-403).
    static manifest: SchemeManifest = {
        name: "run",
        channels: {},
        defaultChannel: "",
        category: "data",
        scope: "session",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
        example: "<<EDIT(run:///helper):Investigate X.:EDIT",
    };

    // EDIT(run:///<name>):prompt — spawn a new sister run; the prompt seeds its
    // first loop. A fresh name only; "self" cannot be spawned.
    async edit(statement: EditStatement, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string; body?: string }> {
        const name = Run.#runName(statement.target);
        if (name === null) return { status: 400, error: "run:// spawn requires a run name (run:///<name>)" };
        if (name === "" || name === ".") return { status: 400, error: "run:// spawn cannot target self" };
        if (ctx.injectRun === undefined) throw new Error("run.edit: injectRun capability absent");
        const denied = await RunCap.deny(ctx.db, ctx.sessionId);
        if (denied !== null) return denied;
        // reuses fork.sql's run-insert (identical INSERT … RETURNING id).
        const row = await (ctx.db.fork_insert_run as PrepMethod).get<{ id: number }>({
            session_id: ctx.sessionId, name, parent_run_id: ctx.runId, origin: ctx.writer,
        });
        if (row === undefined) throw new Error("run.edit: run insert returned no row");
        await ctx.injectRun({ sessionId: ctx.sessionId, runId: row.id, prompt: statement.body ?? "" });
        return { status: 200, body: name };
    }

    // SEND(run:///<name>):hint — irc; deliver the hint to an existing sister run.
    // `run:///.` messages self.
    async send(statement: SendStatement, ctx: PlurnkSchemeContext): Promise<{ status: number; error?: string }> {
        const name = Run.#runName(statement.target);
        if (name === null) return { status: 400, error: "run:// irc requires a run name (run:///<name>)" };
        if (ctx.injectRun === undefined) throw new Error("run.send: injectRun capability absent");
        let runId = ctx.runId;
        if (name !== "" && name !== ".") {
            const row = await (ctx.db.run_resolve_by_name as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, name });
            if (row === undefined) return { status: 404, error: `run:///${name} not found in this session` };
            runId = row.id;
        }
        // SEND's body is a SendBody { raw, json } (or a bare string in some forms);
        // the irc message is its raw text.
        const body = statement.body;
        const prompt = body === null ? "" : typeof body === "string" ? body : body.raw;
        await ctx.injectRun({ sessionId: ctx.sessionId, runId, prompt });
        return { status: 200 };
    }

    // The run name from a run:// target: pathname sans leading slash(es). null
    // when the target isn't a run:// url; "" / "." denote self.
    static #runName(target: ParsedPath | null): string | null {
        if (target === null || target.kind !== "url" || target.scheme !== "run") return null;
        return target.pathname.replace(/^\/+/, "");
    }
}
