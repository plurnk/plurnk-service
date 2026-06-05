// Shared dispatch helper used by every op.* RPC method. Wraps a parsed
// PlurnkStatement in a client-origin turn inside the connection's client
// loop, dispatches via Engine.dispatch, fires the log/entry notification
// to all clients attached to the same session, and returns the dispatch
// result for the RPC response.

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { HandlerContext } from "../MethodRegistry.ts";
import { insertClientTurn } from "../clientTurn.ts";
import { fetchLogEntry } from "../logEntry.ts";
import { ensureClientLoop } from "../envelope.ts";

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
            ctx.session.clientLoopId = await ensureClientLoop(ctx.db, runId);
        }
        const clientLoopId = ctx.session.clientLoopId;
        const turnId = await insertClientTurn(ctx.db, clientLoopId);
        const result = await ctx.engine.dispatch({
            statement,
            sessionId,
            runId,
            loopId: clientLoopId,
            turnId,
            sequence: 1,
            origin: "client",
            onDispatch: (logEntryId) => {
                void (async () => {
                    const entry = await fetchLogEntry(ctx.db, logEntryId);
                    ctx.notify({ sessionId }, "log/entry", { entry });
                })();
            },
        });
        return result as DispatchAsClientResult;
    }
}
