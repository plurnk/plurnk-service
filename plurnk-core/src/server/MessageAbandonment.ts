// {§message-abandonment} — a loop that ends with another session's message unanswered answers it 499 by the
// daemon's hand: one SEND to each message's address, in a maintenance turn of the loop that ended, so the
// sender wakes and reads the decline instead of waiting on a loop that is gone. No loop is opened: a cancelled
// scope stays cancelled ({§session-lifecycle-no-resurrection}); the turn belongs to the ended loop.
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { Db } from "../core/Db.ts";
import type Engine from "../core/Engine.ts";
import Turn from "../core/Turn.ts";
import TurnOps from "../core/TurnOps.ts";

export default class MessageAbandonment {
    static detail(loopId: number, status: number): string {
        return `Loop ${loopId} ended with status ${status}; this message was not answered.`;
    }

    // The messages the ended loop still holds without a completion, each completed 499 with the fact of the
    // ending as the body. Returns how many were completed; none is the ordinary case.
    static async complete(engine: Engine, db: Db, workspaceId: number, sessionId: number, loopId: number, status: number): Promise<number> {
        const open = await db.drain_abandoned_messages.all<{ path: string }>({ loop_id: loopId });
        if (open.length === 0) return 0;
        const text = open
            .map(({ path }) => `\`\`\`\`SEND (${path}) [499]\n${MessageAbandonment.detail(loopId, status)}\n\`\`\`\``)
            .join("\n\n");
        const parsed = PlurnkParser.parseStatements(text, { executors: [] });
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        if (statements.length !== open.length) throw new Error(`message abandonment: ${open.length} messages, ${statements.length} completions parsed`);
        const source = TurnOps.renderInternal(statements);
        const admitted = TurnOps.parseInternal(source);
        const { id: turnId } = await Turn.open(db, { loopId, producer: "_plurnk", kind: "maintenance" });
        // The executor completes the turn it ran; only a turn it never finished is closed here, as failed.
        let turnOpen = true;
        try {
            await engine.executeAdmittedTurn({
                statements: admitted,
                source,
                emission: null,
                origin: "_plurnk",
                workspaceId,
                sessionId,
                loopId,
                turnId,
                fromSequence: 1,
                failOnOperationError: true,
            });
            turnOpen = false;
        } catch (cause) {
            if (turnOpen) {
                try { await Turn.complete(db, turnId, 500); } catch { /* the executor may have closed it */ }
            }
            throw cause;
        }
        return open.length;
    }
}
