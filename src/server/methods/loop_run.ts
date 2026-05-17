// loop.run — model-driven loop. Reads sysprompt, creates a new model loop
// in the connection's run, calls Engine.runLoop with onDispatch firing
// log/entry notifications, fires loop/terminated on completion.

import { readFile } from "node:fs/promises";
import type MethodRegistry from "../MethodRegistry.ts";
import { fetchLogEntry } from "../logEntry.ts";
import { PATHS } from "../../index.ts";

interface Params {
    prompt: string;
    maxTurns?: number;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("loop.run", {
        handler: async (params, ctx) => {
            if (ctx.session === null) throw new Error("loop.run requires an attached session");
            if (ctx.provider === null) {
                return { status: 501, error: "no provider configured at the daemon" };
            }
            const p = (params ?? {}) as Params;
            if (typeof p.prompt !== "string" || p.prompt.length === 0) {
                throw new Error("loop.run requires non-empty params.prompt");
            }
            const maxTurns = p.maxTurns ?? Number(process.env.PLURNK_MAX_TURNS ?? "50");

            const { sessionId, runId } = ctx.session;
            const systemPrompt = await readFile(PATHS.instructionsSystem, "utf8");

            // Create a new model loop in the run (separate from the client loop).
            const seq = (ctx.db
                .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM loops WHERE run_id = ?")
                .get(runId) as { next: number }).next;
            const loop = ctx.db
                .prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, ?, 102, ?) RETURNING id")
                .get(runId, seq, p.prompt) as { id: number };
            const loopId = loop.id;

            const onDispatch = (logEntryId: number): void => {
                const entry = fetchLogEntry(ctx.db, logEntryId);
                ctx.notify({ sessionId }, "log/entry", { entry });
            };

            const result = await ctx.engine.runLoop({
                provider: ctx.provider,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: p.prompt },
                ],
                sessionId, runId, loopId, maxTurns,
                origin: "model",
                onDispatch,
            });

            ctx.notify({ sessionId }, "loop/terminated", {
                loopId,
                finalStatus: result.finalStatus,
                hitMaxTurns: result.hitMaxTurns,
            });

            return { loopId, ...result };
        },
        description: "Run a model-driven loop with a prompt. Streams log/entry notifications during; fires loop/terminated on completion.",
        params: {
            prompt: "string — user prompt for the loop",
            maxTurns: "number? — safety cap on turns (default PLURNK_MAX_TURNS or 50)",
        },
        requiresInit: true,
        longRunning: true,
    });
};
