// loop.run — model-driven loop. Validates params, resolves provider,
// delegates to daemon.inject. inject decides: active drain → write prompt
// entry for next turn; idle → enqueue + start drain.

import { readFile } from "node:fs/promises";
import type MethodRegistry from "../MethodRegistry.ts";
import { Paths } from "../../index.ts";
import { parseAliasesFromEnv } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../core/ProviderInstantiate.ts";
import Envelope from "../envelope.ts";
import type { Provider } from "@plurnk/plurnk-providers";

// Per-call flags shape on loop.run. Each flag persists to loops.flags;
// Engine.dispatch consults via SchemeRegistry.resolveForLoop to gate
// schemes whose manifest affinity matches (excludedInAsk / requiresWeb /
// requiresInteraction). noProposals is NOT a gate — it's a proposal-
// resolution stance (server-side auto-reject, inverse of yolo; see
// server/noProposals.ts), invisible to the model. noWeb/noInteraction are accepted
// for wire uniformity but have no current consumers (http and ask-user
// primitives haven't shipped); they activate the moment a scheme opts
// into the affinity.
interface LoopRunFlags {
    yolo?: boolean;
    noProposals?: boolean;
    noWeb?: boolean;
    noInteraction?: boolean;
    mode?: "ask" | "act";
}

interface Params {
    prompt: string;
    maxTurns?: number;
    alias?: string;
    flags?: LoopRunFlags;
    persona?: string | null;
}

export default class LoopRunMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("loop.run", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("loop.run requires an attached session");
                const p = params as Params;
                if (typeof p.prompt !== "string" || p.prompt.length === 0) {
                    throw new Error("loop.run requires non-empty params.prompt");
                }
                // Validate flags early — fail-fast on bad input regardless of
                // provider config. Actual persistence happens after loop insert.
                if (p.flags !== undefined) {
                    if (typeof p.flags !== "object" || p.flags === null || Array.isArray(p.flags)) {
                        throw new Error("loop.run: flags must be an object");
                    }
                    for (const bool of ["yolo", "noProposals", "noWeb", "noInteraction"] as const) {
                        if (p.flags[bool] !== undefined && typeof p.flags[bool] !== "boolean") {
                            throw new Error(`loop.run: flags.${bool} must be a boolean`);
                        }
                    }
                    if (p.flags.mode !== undefined && p.flags.mode !== "ask" && p.flags.mode !== "act") {
                        throw new Error("loop.run: flags.mode must be 'ask' or 'act'");
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
                    provider = await ProviderInstantiate.instantiateProvider(target);
                }
                if (provider === null) {
                    return { status: 501, error: "no provider configured at the daemon and no alias override supplied" };
                }

                const { sessionId } = ctx.session;
                // §13.7/§1.4 — the model runs in its OWN run, distinct from the
                // connection's client run, so the packet never carries client op.*.
                const modelRunId = ctx.session.modelRunId ?? (ctx.session.modelRunId = await Envelope.ensureModelRun(ctx.db, sessionId));
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");
                const persona = await readFile(Paths.defaultPersona, "utf8");

                // Delegate to the daemon's unified inject surface. Active-drain
                // → write prompt entry for next turn (returns immediately).
                // Idle run → enqueue + start drain (await drain to completion).
                const injected = await ctx.daemon.inject({
                    sessionId, runId: modelRunId, prompt: p.prompt,
                    provider, persona, systemPrompt,
                    maxTurns, flags: p.flags, personaOverride: loopPersona,
                });

                if (injected.action === "injected_next_turn") {
                    // Active drain — prompt landed in the current loop's
                    // next-turn slot. Return immediately; the existing
                    // drain's notifications surface progress.
                    return {
                        loopId: injected.loopId,
                        turnSeq: injected.turnSeq,
                        action: "injected_next_turn",
                        finalStatus: 100,
                        hitMaxTurns: false,
                        turnIds: [],
                    };
                }

                // enqueued_new_loop:
                //   - Drain started by THIS call: firstLoopPromise is the
                //     promise for the loop just enqueued; await it.
                //   - Drain was already active (concurrent loop.run race
                //     where engine.inject returned null): the loop is in
                //     the queue, the existing drain will claim it. No
                //     firstLoopPromise — return immediately with status=100
                //     and let the client subscribe to loop/terminated.
                if (injected.firstLoopPromise === undefined) {
                    return {
                        loopId: injected.loopId,
                        action: "enqueued_new_loop",
                        finalStatus: 100,
                        hitMaxTurns: false,
                        turnIds: [],
                    };
                }
                const first = await injected.firstLoopPromise;
                return {
                    loopId: first.loopId,
                    turnIds: first.turnIds,
                    finalStatus: first.finalStatus,
                    hitMaxTurns: first.hitMaxTurns,
                    usage: first.usage,
                    action: "enqueued_new_loop",
                };
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
    }
}
