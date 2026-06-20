// Shared dispatch helper used by every op.* RPC method. Wraps a parsed
// PlurnkStatement in a client-origin turn inside the connection's client
// loop, dispatches via Engine.dispatch, fires the log/entry notification
// to all clients attached to the same session, and returns the dispatch
// result for the RPC response.

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { HandlerContext } from "../MethodRegistry.ts";
import ClientTurn from "../clientTurn.ts";
import LogEntry from "../logEntry.ts";
import Envelope from "../envelope.ts";

export interface DispatchAsClientResult {
    status: number;
    [key: string]: unknown;
}

export default class DispatchAsClient {
    static async dispatch(ctx: HandlerContext, statement: PlurnkStatement): Promise<DispatchAsClientResult> {
        if (ctx.session === null) {
            throw new Error("dispatchAsClient requires an attached session");
        }
        const { sessionId, runId } = ctx.session;
        if (ctx.session.clientLoopId === null) {
            ctx.session.clientLoopId = await Envelope.ensureClientLoop(ctx.db, runId);
        }
        const clientLoopId = ctx.session.clientLoopId;
        const turnId = await ClientTurn.insertClientTurn(ctx.db, clientLoopId);
        // #253 — the log/entry notification(s) MUST reach the client before the RPC
        // response, per the §methods sequence. The old fire-and-forget IIFE let the
        // response win the race (the un-awaited fetch deferred the notify past the
        // return). Collect the ids synchronously during dispatch, then fetch + notify
        // — awaited — before returning, so the entry precedes the reply in dispatch order.
        const entryIds: number[] = [];
        const result = await ctx.engine.dispatch({
            statement,
            sessionId,
            runId,
            loopId: clientLoopId,
            turnId,
            sequence: 1,
            origin: "client",
            onDispatch: (logEntryId) => { entryIds.push(logEntryId); },
        });
        for (const logEntryId of entryIds) {
            const entry = await LogEntry.fetchLogEntry(ctx.db, logEntryId);
            ctx.notify({ sessionId }, "log/entry", { entry });
        }
        return result as DispatchAsClientResult;
    }
}
