import type { DatabaseSync } from "node:sqlite";
import type { PlurnkStatement, ParsedPath, LineMarker } from "@plurnk/plurnk-grammar";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "../schemes/_entry-crud.ts";

type Origin = "model" | "client" | "system" | "plugin";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ProviderResponse = {
    assistant: { tokens: number; content: string; ops: PlurnkStatement[]; reasoning: string | null };
    assistantRaw: unknown;
};

type Provider = {
    generate: (args: { messages: ChatMessage[]; signal?: AbortSignal }) => Promise<ProviderResponse>;
};

type DispatchContext = {
    statement: PlurnkStatement;
    sessionId: number;
    runId: number;
    loopId: number;
    turnId: number;
    actionIndex: number;
    origin: Origin;
    onDispatch?: (logEntryId: number) => void;
};

type DispatchResult = { status: number; [key: string]: unknown };

type SchemeMethod = (ctx: { db: DatabaseSync; statement: PlurnkStatement; sessionId: number; runId: number; loopId: number; turnId: number }) => Promise<DispatchResult>;

interface SchemeWithCrud {
    readEntry?: (ctx: { db: DatabaseSync; sessionId: number; pathname: string }) => Promise<ReadEntryResult>;
    writeEntry?: (ctx: { db: DatabaseSync; sessionId: number; pathname: string; entry: EntryData; runId: number }) => Promise<WriteEntryResult>;
    deleteEntry?: (ctx: { db: DatabaseSync; sessionId: number; pathname: string }) => Promise<DeleteEntryResult>;
}

const pathnameFromPath = (path: ParsedPath): string => {
    if (path.kind === "url") return path.pathname;
    return path.raw;
};

export default class Engine {
    #db: DatabaseSync;
    #schemes: SchemeRegistry;

    constructor({ db, schemes }: { db: DatabaseSync; schemes: SchemeRegistry }) {
        this.#db = db;
        this.#schemes = schemes;
    }

    async runLoop({
        provider, messages, sessionId, runId, loopId, maxTurns = 50, origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        sessionId: number; runId: number; loopId: number;
        maxTurns?: number;
        origin?: Origin;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnIds: number[]; finalStatus: number; hitMaxTurns: boolean }> {
        const turnIds: number[] = [];

        while (true) {
            signal?.throwIfAborted();

            const row = this.#db.prepare("SELECT status FROM loops WHERE id = ?").get(loopId) as { status: number } | undefined;
            if (row === undefined) throw new Error(`Engine.runLoop: loop ${loopId} not found`);
            if (row.status !== 102) return { turnIds, finalStatus: row.status, hitMaxTurns: false };

            if (turnIds.length >= maxTurns) {
                this.#db.prepare("UPDATE loops SET status = 499 WHERE id = ?").run(loopId);
                return { turnIds, finalStatus: 499, hitMaxTurns: true };
            }

            const turn = await this.runTurn({ provider, messages, sessionId, runId, loopId, origin, signal, onDispatch });
            turnIds.push(turn.turnId);
        }
    }

    async runTurn({
        provider, messages, sessionId, runId, loopId, origin = "model", signal, onDispatch,
    }: {
        provider: Provider;
        messages: ChatMessage[];
        sessionId: number; runId: number; loopId: number;
        origin?: Origin;
        signal?: AbortSignal;
        onDispatch?: (logEntryId: number) => void;
    }): Promise<{ turnId: number; status: number; statuses: number[] }> {
        const response = await provider.generate({ messages, signal });

        const sendOp = response.assistant.ops.findLast(
            (op): op is PlurnkStatement & { op: "SEND"; signal: number } =>
                op.op === "SEND" && typeof op.signal === "number",
        );
        if (sendOp === undefined) throw new Error("Engine.runTurn: assistant ops contain no SEND with a numeric status; cannot determine turn.status");
        const turnStatus = sendOp.signal;

        const seq = (this.#db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = ?").get(loopId) as { next: number }).next;
        const packet = this.#buildPacket(messages, response);
        const turnRow = this.#db
            .prepare("INSERT INTO turns (loop_id, sequence, status, packet, usage_completion) VALUES (?, ?, ?, ?, ?) RETURNING id")
            .get(loopId, seq, turnStatus, JSON.stringify(packet), response.assistant.tokens) as { id: number };
        const turnId = turnRow.id;

        const statuses: number[] = [];
        for (const [actionIndex, statement] of response.assistant.ops.entries()) {
            const result = await this.dispatch({
                statement, sessionId, runId, loopId, turnId, actionIndex, origin, onDispatch,
            });
            statuses.push(result.status);
        }

        return { turnId, status: turnStatus, statuses };
    }

    #buildPacket(messages: ChatMessage[], response: ProviderResponse): object {
        const byRole = (role: ChatMessage["role"]): string =>
            messages.filter((m) => m.role === role).map((m) => m.content).join("\n\n");
        return {
            tokens: response.assistant.tokens,
            system: {
                tokens: 0,
                system_definition: byRole("system"),
                persona: "",
                index: [],
                log: [],
            },
            user: {
                tokens: 0,
                prompt: byRole("user"),
                turn: "",
                system_requirements: "",
            },
            assistant: response.assistant,
            assistantRaw: response.assistantRaw,
        };
    }

    async dispatch(context: DispatchContext): Promise<DispatchResult> {
        const { statement, sessionId, runId, loopId, turnId, actionIndex, origin, onDispatch } = context;
        let result: DispatchResult;
        if (statement.op === "SEND" && statement.path === null) {
            result = this.#handleSendBroadcast(statement, loopId);
        } else if (statement.op === "COPY") {
            result = await this.#handleCopy(statement, { sessionId, runId });
        } else if (statement.op === "MOVE") {
            result = await this.#handleMove(statement, { sessionId, runId });
        } else {
            result = await this.#run(this.#schemeNameOf(statement.path), statement, { sessionId, runId, loopId, turnId });
        }
        const logEntryId = this.#writeLog({ statement, result, runId, loopId, turnId, actionIndex, origin });
        onDispatch?.(logEntryId);
        return result;
    }

    async #handleCopy(statement: PlurnkStatement, ctx: { sessionId: number; runId: number }): Promise<DispatchResult> {
        if (statement.op !== "COPY") throw new Error("unreachable");
        const srcPath = statement.path;
        const dstPath = statement.body;
        if (srcPath === null) return { status: 400, error: "COPY requires source path" };
        if (dstPath === null) return { status: 400, error: "COPY requires destination path (in body slot)" };
        return await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
    }

    async #handleMove(statement: PlurnkStatement, ctx: { sessionId: number; runId: number }): Promise<DispatchResult> {
        if (statement.op !== "MOVE") throw new Error("unreachable");
        const srcPath = statement.path;
        const dstPath = statement.body;
        if (srcPath === null) return { status: 400, error: "MOVE requires source path" };

        const srcSchemeName = this.#schemeNameOf(srcPath);
        if (srcSchemeName === null) return { status: 400, error: "MOVE source must be a URL path with a scheme" };
        const srcHandler = this.#schemes.get(srcSchemeName) as SchemeWithCrud | undefined;
        if (srcHandler === undefined || typeof srcHandler.deleteEntry !== "function") return { status: 501 };

        // Null-body MOVE = delete the source entry (per SPEC §6.5)
        if (dstPath === null) {
            const srcPathname = pathnameFromPath(srcPath);
            const delResult = await srcHandler.deleteEntry({ db: this.#db, sessionId: ctx.sessionId, pathname: srcPathname });
            return { status: delResult.status };
        }

        // Relocation: COPY then DELETE source
        const copyResult = await this.#copyOrchestration({ statement, srcPath, dstPath, ctx });
        if (copyResult.status >= 400) return copyResult;
        const srcPathname = pathnameFromPath(srcPath);
        const delResult = await srcHandler.deleteEntry({ db: this.#db, sessionId: ctx.sessionId, pathname: srcPathname });
        if (delResult.status >= 400) return { status: delResult.status };
        return copyResult;
    }

    async #copyOrchestration({ statement, srcPath, dstPath, ctx }: {
        statement: PlurnkStatement;
        srcPath: ParsedPath;
        dstPath: ParsedPath;
        ctx: { sessionId: number; runId: number };
    }): Promise<DispatchResult> {
        const srcSchemeName = this.#schemeNameOf(srcPath);
        const dstSchemeName = this.#schemeNameOf(dstPath);
        if (srcSchemeName === null || dstSchemeName === null) return { status: 400, error: "COPY/MOVE require URL paths with schemes" };

        const srcHandler = this.#schemes.get(srcSchemeName) as SchemeWithCrud | undefined;
        const dstHandler = this.#schemes.get(dstSchemeName) as SchemeWithCrud | undefined;
        if (srcHandler === undefined || dstHandler === undefined) return { status: 501 };
        if (typeof srcHandler.readEntry !== "function" || typeof dstHandler.writeEntry !== "function") return { status: 501 };

        const srcPathname = pathnameFromPath(srcPath);
        const dstPathname = pathnameFromPath(dstPath);

        const srcResult = await srcHandler.readEntry({ db: this.#db, sessionId: ctx.sessionId, pathname: srcPathname });
        if (srcResult.status !== 200 || srcResult.entry === null) return { status: 404, error: `COPY/MOVE source not found: ${srcSchemeName}://${srcPathname}` };
        const entry = srcResult.entry;

        // Conflict check on destination
        if (typeof dstHandler.readEntry === "function") {
            const dstExists = await dstHandler.readEntry({ db: this.#db, sessionId: ctx.sessionId, pathname: dstPathname });
            if (dstExists.status === 200) return { status: 409, error: `COPY/MOVE destination exists: ${dstSchemeName}://${dstPathname}` };
        }

        // Mimetype compatibility check against the destination scheme's manifest
        const dstChannels = (dstHandler.constructor as { channels?: Record<string, string> }).channels ?? {};
        for (const [channelName, channelData] of Object.entries(entry.channels)) {
            const expectedMimetype = dstChannels[channelName];
            if (expectedMimetype !== undefined && expectedMimetype !== channelData.mimetype) {
                return { status: 415, error: `mimetype mismatch on channel '${channelName}': ${channelData.mimetype} vs ${expectedMimetype}` };
            }
        }

        // Tag resolution: signal = replace; absent/empty = carry from source
        const tags = (Array.isArray(statement.signal) && statement.signal.length > 0)
            ? statement.signal
            : entry.tags;

        const writeResult = await dstHandler.writeEntry({
            db: this.#db,
            sessionId: ctx.sessionId,
            pathname: dstPathname,
            entry: { channels: entry.channels, tags },
            runId: ctx.runId,
        });
        return { status: writeResult.status, entryId: writeResult.entryId, created: writeResult.created };
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
    }): number {
        const target = this.#extractTarget(statement.path);
        const lineMarkerJson = "lineMarker" in statement && statement.lineMarker !== null
            ? JSON.stringify(statement.lineMarker as LineMarker)
            : null;
        const row = this.#db.prepare(
            `INSERT INTO log_entries (
                run_id, loop_id, turn_id, action_index, origin, op, suffix, signal,
                target_scheme, target_username, target_password, target_hostname, target_port,
                target_pathname, target_params, target_fragment, lineMarker,
                tx, mimetype_tx, rx, mimetype_rx, status_rx
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        ).get(
            runId, loopId, turnId, actionIndex, origin, statement.op, statement.suffix,
            this.#signalToJson(statement.signal),
            target.scheme, target.username, target.password, target.hostname, target.port,
            target.pathname, target.params, target.fragment, lineMarkerJson,
            JSON.stringify(statement), "application/json",
            JSON.stringify(result), "application/json", result.status,
        ) as { id: number };
        return row.id;
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
