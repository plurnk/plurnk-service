// loop.run — model-driven loop. Validates params, resolves provider,
// delegates to daemon.inject. inject decides: active drain → write prompt
// entry for next turn; idle → enqueue + start drain.

import { readFile } from "node:fs/promises";
import type MethodRegistry from "../MethodRegistry.ts";
import { Paths } from "../../index.ts";
import { parseAliasesFromEnv } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../core/ProviderInstantiate.ts";
import SessionSettings from "../../core/session-settings.ts";
import Envelope from "../envelope.ts";
import DispatchAsPlurnk from "./_dispatchAsPlurnk.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import type { EditStatement } from "@plurnk/plurnk-grammar";

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
    model?: string;
    flags?: LoopRunFlags;
    openPaths?: string[];
}

export default class LoopRunMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("loop.run", { // §methods-loop-run
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
                // #260 — workspace paths the daemon foists as turn-0 READs (no client-side inlining).
                if (p.openPaths !== undefined && (!Array.isArray(p.openPaths) || p.openPaths.some((x) => typeof x !== "string" || x.length === 0))) {
                    throw new Error("loop.run: openPaths must be an array of non-empty path strings");
                }
                // PLURNK_SERVICE_MAX_TURNS is the operator turn ceiling (§operator-config): -1 = no
                // cap; positive = a hard cap a per-call maxTurns cannot exceed. §operator-config-max-turns-ceiling
                const ceiling = Number(process.env.PLURNK_SERVICE_MAX_TURNS ?? "-1");
                const requested = p.maxTurns ?? ceiling;
                const maxTurns = ceiling < 0 ? requested : (requested < 0 ? ceiling : Math.min(requested, ceiling));

                // Resolve provider for this call. Per-call alias override (issue
                // #128) takes precedence over ctx.provider; absence falls back to
                // the daemon's boot-time provider.
                let provider: Provider | null = ctx.provider;
                if (p.model !== undefined) {
                    // Client-resolved provider/model (§provider-instantiation-alias-resolution). The
                    // CLIENT resolves its own alias env — always fresh, unlike a long-lived daemon's —
                    // and sends the concrete `<provider>/<model>`; the daemon instantiates it with ITS
                    // keys, so the daemon needs no matching alias. Same first-slash split as the env knob.
                    if (typeof p.model !== "string" || p.model.length === 0) {
                        throw new Error("loop.run: model must be a non-empty '<provider>/<model>' string");
                    }
                    const slash = p.model.indexOf("/");
                    if (slash <= 0) throw new Error(`loop.run: model must be '<provider>/<model>', got '${p.model}'`);
                    const label = typeof p.alias === "string" && p.alias.length > 0 ? p.alias : p.model;
                    provider = await ProviderInstantiate.instantiateProvider({ alias: label, provider: p.model.slice(0, slash), model: p.model.slice(slash + 1) });
                } else if (p.alias !== undefined) {
                    if (typeof p.alias !== "string" || p.alias.length === 0) {
                        throw new Error("loop.run: alias must be a non-empty string");
                    }
                    const aliases = parseAliasesFromEnv();
                    const target = aliases.find((a) => a.alias === p.alias!.toLowerCase());
                    if (target === undefined) {
                        // Aliases case-fold (PLURNK_MODEL_ccp === PLURNK_MODEL_CCP), so the miss is
                        // never casing — it's the DAEMON's environment lacking the key, typically a
                        // client-side shell export the running daemon never inherited. List what it
                        // does know so the env gap is obvious.
                        const known = aliases.map((a) => a.alias).join(", ") || "none";
                        throw new Error(`loop.run: unknown alias '${p.alias}' (the daemon knows: ${known}). Aliases case-fold, so casing isn't it — the daemon's environment declares no PLURNK_MODEL_${p.alias.toLowerCase()}. Set it where the daemon runs and restart; a client-side shell export the daemon didn't inherit is the usual cause.`);
                    }
                    provider = await ProviderInstantiate.instantiateProvider(target);
                }
                if (provider === null) {
                    return { status: 501, error: "no provider configured at the daemon and no alias override supplied" };
                }

                const { sessionId } = ctx.session;
                // §connection-lifecycle/§machine-processes — the model runs in its OWN run, distinct from the
                // connection's client run, so the packet never carries client op.*.
                const modelRunId = ctx.session.modelRunId ?? (ctx.session.modelRunId = await Envelope.ensureModelRun(ctx.db, sessionId));
                const systemPrompt = await readFile(Paths.instructionsSystem, "utf8");

                // Operator reference docs (PLURNK_SERVICE_MD_<ALIAS>): materialize each as
                // a plurnk:///<ALIAS>.md entry via the self-hosting keystone (a
                // plurnk run, §actor-boundary) so the model READs it at turn 0 (Engine.runTurn
                // foists the READ). The materializing EDITs land in the plurnk
                // run's log, invisible to the model. Missing files are skipped.
                // #231 — materialize env docs (PLURNK_SERVICE_MD_*) UNION the session's client docs
                // (settings.mdDocs); client wins on alias collision. Engine.runTurn foists a
                // READ of the same set at turn-0.
                const { mdDocs } = await SessionSettings.read(ctx.db, sessionId);
                const docStmts: EditStatement[] = (await SessionSettings.resolveDocs(mdDocs)).map((doc) => ({
                    op: "EDIT", suffix: "", signal: null,
                    target: { kind: "url", raw: `plurnk:///${doc.entryName}`, scheme: "plurnk", username: null, password: null, hostname: null, port: null, pathname: `/${doc.entryName}`, params: {}, fragment: null },
                    lineMarker: null, body: doc.content, position: { line: 1, column: 1 },
                }));
                // #note12 — materialize the daughter scheme/exec reference docs at
                // plurnk://docs/<name>.md so the catalogue's doc-links READ + carry token cost.
                // Per-inject like the operator mdDocs above (idempotent EDITs). One-time
                // session-scope seeding is a future refinement — seeding at session.create
                // shifts every session's initial entry/run state (origin, counts, coordinates)
                // and breaks the no-loop.run op.* tests, not worth the churn for the redundancy saved.
                for (const { name, content } of ctx.engine.docEntries()) {
                    docStmts.push({
                        op: "EDIT", suffix: "", signal: null,
                        target: { kind: "url", raw: `plurnk://docs/${name}.md`, scheme: "plurnk", username: null, password: null, hostname: "docs", port: null, pathname: `/${name}.md`, params: {}, fragment: null },
                        lineMarker: null, body: content, position: { line: 1, column: 1 },
                    });
                }
                if (docStmts.length > 0) await DispatchAsPlurnk.dispatch(ctx.engine, ctx.db, sessionId, docStmts);

                // Delegate to the daemon's unified inject surface. Active-drain
                // → write prompt entry for next turn (returns immediately).
                // Idle run → enqueue + start drain (await drain to completion).
                const injected = await ctx.daemon.inject({
                    sessionId, runId: modelRunId, prompt: p.prompt,
                    provider, systemPrompt,
                    maxTurns, flags: p.flags, openPaths: p.openPaths,
                });

                if (injected.action === "injected_next_turn") {
                    // Active drain — prompt landed in the current loop's
                    // next-turn slot. Return immediately; the existing
                    // drain's notifications surface progress.
                    return {
                        loopId: injected.loopId,
                        modelRunId,
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
                        modelRunId,
                        action: "enqueued_new_loop",
                        finalStatus: 100,
                        hitMaxTurns: false,
                        turnIds: [],
                    };
                }
                // Model 3 — accept and return immediately; the drain (already started, its
                // firstLoopPromise .catch()'d in Daemon) runs the loop async. Its outcome rides
                // loop/terminated; loop.run never blocks on a loop that may park indefinitely
                // (SEND[202]). §run-lifecycle-wake-liveness.
                return {
                    loopId: injected.loopId,
                    modelRunId,
                    action: "enqueued_new_loop",
                    finalStatus: 100,
                    turnIds: [],  // #266 — every loop.run return carries turnIds (never absent → client undefined.length)
                };
            },
            description: "Run a model-driven loop with a prompt. Optional `model` (`<provider>/<model>`, client-resolved) runs on that provider using the daemon's keys — preferred over `alias`, which resolves a PLURNK_MODEL_<alias> override in the DAEMON's env. Optional `flags.yolo:true` enables server-side YOLO (daemon auto-accepts proposals in-process; intended for benchmarks and automation, NOT standard client UX — see client SPEC §open-fold for client-side YOLO). Returns `modelRunId` — the conversation's run; a conversation client reads it via `log.read({ runId })` for live tail and hydration (§214). Streams log/entry notifications; fires loop/terminated on completion.",
            params: {
                prompt: "string — user prompt for the loop",
                maxTurns: "number? — per-loop turn request; the PLURNK_SERVICE_MAX_TURNS operator ceiling caps it when set (§operator-config)",
                alias: "string? — model alias resolved in the DAEMON's env (overrides PLURNK_MODEL); prefer `model` for client-resolved selection",
                model: "string? — client-resolved '<provider>/<model>' to run on, instantiated with the daemon's keys; bypasses daemon alias lookup, takes precedence over `alias`",
                flags: "object? — per-loop flags. Currently accepts { yolo?: boolean }. Server YOLO; not for routine client use.",
                openPaths: "string[]? — workspace paths (@file refs) the daemon READs into the loop's first turn so their content sits in front of the model; daemon-foist, no client-side byte inlining (#260).",
            },
            requiresInit: true,
            longRunning: false,
        });
    }
}
