import type { DatabaseSync } from "node:sqlite";
import type { PlurnkStatement, ParsedPath, LineMarker } from "@plurnk/plurnk-grammar";
import type SchemeRegistry from "./SchemeRegistry.ts";

type Origin = "model" | "client" | "system" | "plugin";

type DispatchContext = {
    statement: PlurnkStatement;
    sessionId: number;
    runId: number;
    loopId: number;
    turnId: number;
    actionIndex: number;
    origin: Origin;
};

type DispatchResult = { status: number; [key: string]: unknown };

type SchemeMethod = (ctx: { db: DatabaseSync; statement: PlurnkStatement; sessionId: number; runId: number; loopId: number; turnId: number }) => Promise<DispatchResult>;

export default class Engine {
    #db: DatabaseSync;
    #schemes: SchemeRegistry;

    constructor({ db, schemes }: { db: DatabaseSync; schemes: SchemeRegistry }) {
        this.#db = db;
        this.#schemes = schemes;
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        const { statement, sessionId, runId, loopId, turnId, actionIndex, origin } = context;
        const result = statement.op === "SEND" && statement.path === null
            ? this.#handleSendBroadcast(statement, loopId)
            : await this.#run(this.#schemeNameOf(statement.path), statement, { sessionId, runId, loopId, turnId });
        this.#writeLog({ statement, result, runId, loopId, turnId, actionIndex, origin });
        return result;
    }

    #handleSendBroadcast(statement: PlurnkStatement, loopId: number): DispatchResult {
        if (statement.op !== "SEND") throw new Error("unreachable");
        const status = statement.signal;
        if (status === null) return { status: 400 };
        if (status === 200 || status === 499) {
            this.#db.prepare("UPDATE loops SET status = ? WHERE id = ?").run(status, loopId);
        }
        return { status };
    }

    async #run(
        schemeName: string | null,
        statement: PlurnkStatement,
        ctx: { sessionId: number; runId: number; loopId: number; turnId: number },
    ): Promise<DispatchResult> {
        if (schemeName === null) return { status: 400 };
        const handler = this.#schemes.get(schemeName) as Record<string, SchemeMethod | undefined> | undefined;
        if (handler === undefined) return { status: 501 };
        const methodName = statement.op.toLowerCase();
        const method = handler[methodName];
        if (typeof method !== "function") return { status: 501 };
        return method.call(handler, { db: this.#db, statement, ...ctx });
    }

    #schemeNameOf(path: ParsedPath | null): string | null {
        if (path === null) return null;
        if (path.kind === "url") return path.scheme;
        return null;
    }

    #writeLog({
        statement, result, runId, loopId, turnId, actionIndex, origin,
    }: {
        statement: PlurnkStatement; result: DispatchResult;
        runId: number; loopId: number; turnId: number; actionIndex: number; origin: Origin;
    }): void {
        const target = this.#extractTarget(statement.path);
        const lineMarkerJson = "lineMarker" in statement && statement.lineMarker !== null
            ? JSON.stringify(statement.lineMarker as LineMarker)
            : null;
        this.#db.prepare(
            `INSERT INTO log_entries (
                run_id, loop_id, turn_id, action_index, origin, op, suffix, signal,
                target_scheme, target_username, target_password, target_hostname, target_port,
                target_pathname, target_params, target_fragment, lineMarker,
                tx, mimetype_tx, rx, mimetype_rx, status_rx
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            runId, loopId, turnId, actionIndex, origin, statement.op, statement.suffix,
            this.#signalToJson(statement.signal),
            target.scheme, target.username, target.password, target.hostname, target.port,
            target.pathname, target.params, target.fragment, lineMarkerJson,
            JSON.stringify(statement), "application/json",
            JSON.stringify(result), "application/json", result.status,
        );
    }

    #extractTarget(path: ParsedPath | null): {
        scheme: string | null; username: string | null; password: string | null;
        hostname: string | null; port: number | null; pathname: string | null;
        params: string | null; fragment: string | null;
    } {
        if (path === null) return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: null, params: null, fragment: null };
        if (path.kind === "local") return { scheme: null, username: null, password: null, hostname: null, port: null, pathname: path.raw, params: null, fragment: null };
        return {
            scheme: path.scheme, username: path.username, password: path.password,
            hostname: path.hostname, port: path.port, pathname: path.pathname,
            params: JSON.stringify(path.params), fragment: path.fragment,
        };
    }

    #signalToJson(signal: unknown): string | null {
        if (signal === null || signal === undefined) return null;
        return JSON.stringify(signal);
    }
}
