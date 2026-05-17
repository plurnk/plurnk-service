// Shared dispatch helper used by every op.* RPC method. Wraps a parsed
// PlurnkStatement in a client-origin turn inside the connection's client
// loop, dispatches via Engine.dispatch, fires the log/entry notification
// to all clients attached to the same session, and returns the dispatch
// result for the RPC response.

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { HandlerContext } from "../MethodRegistry.ts";
import { insertClientTurn } from "../clientTurn.ts";
import { fetchLogEntry } from "../logEntry.ts";

export interface DispatchAsClientResult {
    status: number;
    [key: string]: unknown;
}

export const dispatchAsClient = async (ctx: HandlerContext, statement: PlurnkStatement): Promise<DispatchAsClientResult> => {
    if (ctx.session === null) {
        throw new Error("dispatchAsClient requires an attached session");
    }
    const { sessionId, runId, clientLoopId } = ctx.session;
    const turnId = insertClientTurn(ctx.db, clientLoopId);
    const result = await ctx.engine.dispatch({
        statement,
        sessionId,
        runId,
        loopId: clientLoopId,
        turnId,
        actionIndex: 0,
        origin: "client",
        onDispatch: (logEntryId) => {
            const entry = fetchLogEntry(ctx.db, logEntryId);
            ctx.notify({ sessionId }, "log/entry", { entry });
        },
    });
    return result as DispatchAsClientResult;
};
