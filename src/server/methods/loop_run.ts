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
import { DEFAULT_LOOP_FLAGS } from "../../core/scheme-types.ts";

// Per-call flags shape on loop.run. Only documented working flags are
// accepted today; LoopFlags.noProposals / noWeb / noInteraction are inert
// pending an askUser-style primitive (see plurnk:// pondering notes).
interface LoopRunFlags {
    yolo?: boolean;
}

interface Params {
    prompt: string;
    maxTurns?: number;
    alias?: string;
    flags?: LoopRunFlags;
    persona?: string | null;
}

export const register = (registry: MethodRegistry): void => {
    registry.registerMethod("loop.run", {
        handler: async (params, ctx) => {
            if (ctx.session === null) throw new Error("loop.run requires an attached session");
            const p = (params ?? {}) as Params;
            if (typeof p.prompt !== "string" || p.prompt.length === 0) {
                throw new Error("loop.run requires non-empty params.prompt");
            }
            // Validate flags early — fail-fast on bad input regardless of
            // provider config. Actual persistence happens after loop insert.
            if (p.flags !== undefined) {
                if (typeof p.flags !== "object" || p.flags === null || Array.isArray(p.flags)) {
                    throw new Error("loop.run: flags must be an object");
                }
                if (p.flags.yolo !== undefined && typeof p.flags.yolo !== "boolean") {
                    throw new Error("loop.run: flags.yolo must be a boolean");
                }
            }
            const loopPersona = p.persona ?? null;
            if (loopPersona !== null && typeof loopPersona !== "string") {
                throw new Error("loop.run: persona must be a string or null");
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
            // packet.system.persona — default from persona.md. issue #150 will
            // add loop.run({persona}) and session.attach({persona}) overrides;
            // until then every loop carries the default.
            const persona = await readFile(PATHS.defaultPersona, "utf8");

            const seqRow = await (ctx.db.loop_run_next_sequence as PrepMethod).get<{ next: number }>({ run_id: runId });
            if (seqRow === undefined) throw new Error("loop.run: next-sequence query returned no row");
            const loop = await (ctx.db.loop_run_insert_loop as PrepMethod).get<{ id: number }>({
                run_id: runId, sequence: seqRow.next, prompt: p.prompt, persona: loopPersona,
            });
            if (loop === undefined) throw new Error("loop.run: loop insert returned no row");
            const loopId = loop.id;

            // Persist per-loop flags if supplied. Merge over DEFAULT_LOOP_FLAGS
            // so the JSON column always has a complete shape — yolo listener
            // and scheme dispatch read with the same merge convention.
            // (Param validation happened up-front; this branch only persists.)
            if (p.flags !== undefined) {
                const merged = { ...DEFAULT_LOOP_FLAGS, ...p.flags };
                await (ctx.db.engine_set_loop_flags as PrepMethod).run({
                    loop_id: loopId, flags: JSON.stringify(merged),
                });
            }

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
                persona,
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
        description: "Run a model-driven loop with a prompt. Optional per-call `alias` resolves a PLURNK_MODEL_<alias> override. Optional `flags.yolo:true` enables server-side YOLO (daemon auto-accepts proposals in-process; intended for benchmarks and automation, NOT standard client UX — see client SPEC §6.3 for client-side YOLO). Optional `persona` sets the loop-level persona override (highest precedence in the cascade loops > runs > sessions > PLURNK_PERSONA file). Streams log/entry notifications; fires loop/terminated on completion.",
        params: {
            prompt: "string — user prompt for the loop",
            maxTurns: "number? — safety cap on turns (default PLURNK_MAX_TURNS or 50)",
            alias: "string? — model alias to use for this loop (overrides the daemon's PLURNK_MODEL)",
            flags: "object? — per-loop flags. Currently accepts { yolo?: boolean }. Server YOLO; not for routine client use.",
            persona: "string? — loop-level persona (text/markdown); takes precedence over session and run personas",
        },
        requiresInit: true,
        longRunning: true,
    });
};
