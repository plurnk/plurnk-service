// run.fork — branch a run's log into a new run in the same session (#228). Wraps
// Fork.fork: deep-copies loops/turns/entries (fold-state + attribution intact)
// into a parent_run_id-lineaged branch that SHARES the session's world (entries +
// overlay), copying nothing of it. Defaults to the session's model run (the
// conversation); the conversation client (e.g. :AI????) forks it, then reads the
// branch via log.read({runId}).

import type MethodRegistry from "../MethodRegistry.ts";
import type { PrepMethod } from "../../core/Db.ts";
import Fork from "../../core/fork.ts";
import Envelope from "../envelope.ts";

interface Params {
    runId?: number;
    name?: string;
}

export default class RunForkMethod {
    static register(registry: MethodRegistry): void {
        registry.registerMethod("run.fork", {
            handler: async (params, ctx) => {
                if (ctx.session === null) throw new Error("run.fork requires an attached session");
                const p = params as Params;
                // #248 — name at instantiation, immutable after. Mirror session.attach's runName:
                // non-empty + reject reserved; and (runs.name is UNIQUE per session) refuse a taken
                // name up front rather than fail at the insert. No run.rename — names are frozen.
                if (p.name !== undefined) {
                    if (typeof p.name !== "string" || p.name.length === 0) throw new Error("run.fork: name must be a non-empty string");
                    if (Envelope.RESERVED_RUN_NAMES.has(p.name.toLowerCase())) throw new Error(`run.fork: name "${p.name}" is reserved`);
                    const taken = await (ctx.db.envelope_get_run_by_name as PrepMethod).get<{ id: number }>({ session_id: ctx.session.sessionId, name: p.name });
                    if (taken !== undefined) throw new Error(`run.fork: a run named "${p.name}" already exists — run names are immutable, pick another`);
                }
                let runId = p.runId;
                if (runId === undefined) {
                    if (ctx.session.modelRunId === null) throw new Error("run.fork: no model run to fork — start one with loop.run, or pass runId");
                    runId = ctx.session.modelRunId;
                } else {
                    if (typeof runId !== "number" || !Number.isInteger(runId)) throw new Error("run.fork: runId must be an integer");
                    const owner = await (ctx.db.envelope_get_run_by_id as PrepMethod).get<{ session_id: number }>({ id: runId });
                    if (owner === undefined) throw new Error(`run.fork: run ${runId} not found`);
                    if (owner.session_id !== ctx.session.sessionId) throw new Error(`run.fork: run ${runId} is not in this session`);
                }
                const branchRunId = await Fork.fork(ctx.db, runId, p.name);
                const branch = await (ctx.db.envelope_get_run_by_id as PrepMethod).get<{ name: string }>({ id: branchRunId });
                return { runId: branchRunId, runName: branch?.name ?? null, parentRunId: runId };
            },
            description: "Fork a run — branch its log into a new run in the same session (parent_run_id lineage), sharing the session's world (entries + overlay), copying nothing of it. Defaults to the session's model run (the conversation); an explicit runId forks any run in the session (ownership-checked). Optional `name` names the branch at instantiation — immutable after (no rename; a run is permanent history, §machine-processes-run-is-its-log), reserved + taken names rejected (mirrors session.attach); defaults to `<parent>-fork`. Returns the new run's {runId, runName}; a conversation client reads it via log.read({runId}). §machine-processes / #228.",
            params: {
                runId: "number? — the run to fork; defaults to the session's current model run (the conversation)",
                name: "string? — name the branched run at instantiation (immutable; reserved/taken names rejected). Defaults to <parent>-fork.",
            },
            requiresInit: true,
        });
    }
}
