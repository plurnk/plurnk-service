// loop.inject — speak into a run already in flight (#193). Routes the prompt
// through the daemon's unified inject surface: an active drain folds it into the
// next turn (the "BTW" mid-run nudge; steer instead of cancel; answer a model's
// intermediate SEND), an idle-but-existing run enqueues a fresh loop. Returns
// immediately ({action, loopId}); the client watches progress via the run's
// notifications. Unlike loop.run it never STARTS a run — no model run to talk
// to → use loop.run.

import { readFile } from "node:fs/promises";
import type MethodRegistry from "../MethodRegistry.ts";
import { Paths } from "../../index.ts";

interface Params {
    prompt: string;
    maxTurns?: number;
    flags?: { yolo?: boolean };
}

export default class LoopInjectMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("loop.inject", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("loop.inject requires an attached session");
                const p = params as Params;
                if (typeof p.prompt !== "string" || p.prompt.length === 0) throw new Error("loop.inject requires non-empty params.prompt");
                if (p.flags !== undefined) {
                    if (typeof p.flags !== "object" || p.flags === null || Array.isArray(p.flags)) throw new Error("loop.inject: flags must be an object");
                    if (p.flags.yolo !== undefined && typeof p.flags.yolo !== "boolean") throw new Error("loop.inject: flags.yolo must be a boolean");
                }
                // inject speaks to an EXISTING run; loop.run is what starts one.
                const modelRunId = ctx.session.modelRunId;
                if (modelRunId === null) throw new Error("loop.inject: no model run to inject into — start one with loop.run");
                if (ctx.provider === null) return { status: 501, error: "no provider configured at the daemon" };

                // PLURNK_MAX_TURNS operator ceiling, same as loop.run (§operator-config).
                const ceiling = Number(process.env.PLURNK_MAX_TURNS ?? "-1");
                const requested = p.maxTurns ?? ceiling;
                const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));

                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const persona = await readFile(Paths.defaultPersona, "utf8");
                const injected = await ctx.daemon.inject({
                    sessionId: ctx.session.sessionId, runId: modelRunId, prompt: p.prompt,
                    provider: ctx.provider, persona, systemPrompt, maxTurns, flags: p.flags,
                });

                // Fire-and-forget: return as soon as the prompt is placed; the client
                // watches the run via log/entry + loop/terminated. Swallow background
                // drain rejections so an enqueued loop's failure can't crash the daemon.
                injected.firstLoopPromise?.catch(() => {});
                injected.drainPromise?.catch(() => {});
                return { action: injected.action, loopId: injected.loopId, turnSeq: injected.turnSeq, modelRunId };
            },
            description: "Inject a prompt into the session's in-flight model run — the missing 'talk to a running loop' half of the conversation model. An active drain folds the prompt into its next turn (the mid-run nudge / 'BTW' idiom; steer instead of cancel; answer a model's intermediate SEND); an idle run enqueues a fresh loop. Returns immediately with {action, loopId}; progress surfaces via the run's log/entry + loop/terminated notifications. Requires an existing model run (loop.run starts one). #193.",
            params: {
                prompt: "string — the prompt to speak into the run",
                maxTurns: "number? — per-loop turn request when this enqueues a fresh loop; the PLURNK_MAX_TURNS ceiling caps it (§operator-config)",
                flags: "object? — { yolo?: boolean } for a freshly-enqueued loop (no effect when folded into an active drain)",
            },
            requiresInit: true,
        });
    }
}
