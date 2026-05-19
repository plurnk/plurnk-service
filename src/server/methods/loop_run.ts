// loop.run — model-driven loop. Reads sysprompt, creates a new model loop
// in the connection's run, calls Engine.runLoop with onDispatch firing
// log/entry notifications, fires loop/terminated on completion.

import { readFile } from "node:fs/promises";
import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";
import { fetchLogEntry } from "../logEntry.ts";
import { PATHS } from "../../index.ts";
import { parseAliasesFromEnv, instantiateProvider } from "../../core/ProviderRegistry.ts";
import type { Provider } from "../../core/ProviderRegistry.ts";

interface Params {
    prompt: string;
    maxTurns?: number;
    alias?: string;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("loop.run", {
        handler: async (params, ctx) => {
            if (ctx.session === null) throw new Error("loop.run requires an attached session");
            const p = (params ?? {}) as Params;
            if (typeof p.prompt !== "string" || p.prompt.length === 0) {
                throw new Error("loop.run requires non-empty params.prompt");
            }
            const maxTurns = p.maxTurns ?? Number(process.env.PLURNK_MAX_TURNS ?? "50");

            // Resolve provider for this call. Per-call alias override (issue
            // #128) takes precedence over ctx.provider; absence falls back to
            // the daemon's boot-time provider.
            let provider: Provider | null = ctx.provider;
            if (p.alias !== undefined) {
                if (typeof p.alias !== "string" || p.alias.length === 0) {
                    throw new Error("loop.run: alias must be a non-empty string");
                }
                const aliases = parseAliasesFromEnv();
                const target = aliases.find((a) => a.alias === p.alias!.toLowerCase());
                if (target === undefined) {
                    throw new Error(`loop.run: unknown alias '${p.alias}'; configure PLURNK_MODEL_${p.alias.toUpperCase()}=<provider>/<model>`);
                }
                provider = await instantiateProvider(target);
            }
            if (provider === null) {
                return { status: 501, error: "no provider configured at the daemon and no alias override supplied" };
            }

            const { sessionId, runId } = ctx.session;
            const systemPrompt = await readFile(PATHS.instructionsSystem, "utf8");

            const seqRow = await (ctx.db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ run_id: runId });
            if (seqRow === undefined) throw new Error("loop.run: next-sequence query returned no row");
            const loop = await (ctx.db.loop_run_insert_loop as PrepMethod).get<{ id: number }>({
                run_id: runId, sequence: seqRow.next, prompt: p.prompt,
            });
            if (loop === undefined) throw new Error("loop.run: loop insert returned no row");
            const loopId = loop.id;

            const onDispatch = (logEntryId: number): void => {
                void (async () => {
                    const entry = await fetchLogEntry(ctx.db, logEntryId);
                    ctx.notify({ sessionId }, "log/entry", { entry });
                })();
            };

            const result = await ctx.engine.runLoop({
                provider,
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
        description: "Run a model-driven loop with a prompt. Optional per-call `alias` resolves a PLURNK_MODEL_<alias> override. Streams log/entry notifications; fires loop/terminated on completion.",
        params: {
            prompt: "string — user prompt for the loop",
            maxTurns: "number? — safety cap on turns (default PLURNK_MAX_TURNS or 50)",
            alias: "string? — model alias to use for this loop (overrides the daemon's PLURNK_MODEL)",
        },
        requiresInit: true,
        longRunning: true,
    });
};
