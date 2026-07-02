// Fork a run — branch the log, share the session (SPEC §machine-processes).
//
// A fork is a NEW run in the SAME session (`parent_run_id` records the lineage),
// holding a deep copy of the parent's log: loops → turns → entries, with their
// fold-state (`expanded`) and attribution (`origin`/`source`) intact. It copies
// nothing of the shared WORLD — the session's entries and overlay are shared, never
// copied, because a run never owned them. But it DOES inherit the parent's run-scope
// SCRATCH (§run-scheme — the run's private workspace, owner-remapped parent → branch):
// "fork = everything-in-common-but-name, then diverges". The §env-delta reconciliation
// snapshot is not copied; the branch first-sights its world like any fresh run.

import type { Db, PrepMethod } from "./Db.ts";

export default class Fork {
    // Terminal loop statuses (§lifecycle-terms) — inherited loops outside this set are clamped to 200.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    static async fork(db: Db, parentRunId: number, name?: string): Promise<number> {
        const parent = await (db.fork_get_run as PrepMethod).get<{ session_id: number; name: string; origin: string }>({ id: parentRunId });
        if (parent === undefined) throw new Error(`fork: run ${parentRunId} not found`);

        // #248 — name the branch at instantiation (immutable after). An explicit name wins; the default
        // is `<parent>-fork-<N>` (N = next free), so N self-forks of one parent are individually
        // addressable instead of all colliding on a single `<parent>-fork` (§run-scheme-fork).
        let branchName = name;
        if (branchName === undefined) {
            const existing = await (db.fork_count_branches as PrepMethod).get<{ n: number }>({ parent_run_id: parentRunId, name_prefix: `${parent.name}-fork%` });
            branchName = `${parent.name}-fork-${(existing?.n ?? 0) + 1}`;
        }
        const branch = await (db.fork_insert_run as PrepMethod).get<{ id: number }>({
            session_id: parent.session_id, name: branchName, parent_run_id: parentRunId, origin: parent.origin,
        });
        if (branch === undefined) throw new Error("fork: branch run insert returned no row");
        const branchRunId = branch.id;

        // loops → new loops, mapping old id → new id. A copied loop is INHERITED HISTORY, never the
        // branch's live work (its own loop is enqueued fresh by injectRun) — so a non-terminal status
        // is clamped to terminal (200). Otherwise a fork taken while the parent's loop is mid-flight (102)
        // would carry a frozen-live loop no drain ever advances, falsely marking the branch forever-live
        // to any liveness check (§run-scheme-fork, the premature-terminate gate §send-premature-terminate).
        const loops = await (db.fork_get_loops as PrepMethod).all<{ id: number; sequence: number; status: number; prompt: string; flags: string }>({ run_id: parentRunId });
        const loopMap = new Map<number, number>();
        for (const l of loops) {
            const status = Fork.#TERMINAL_LOOP.has(l.status) ? l.status : 200;
            const nl = await (db.fork_insert_loop as PrepMethod).get<{ id: number }>({ run_id: branchRunId, sequence: l.sequence, status, prompt: l.prompt, flags: l.flags });
            if (nl === undefined) throw new Error("fork: loop insert returned no row");
            loopMap.set(l.id, nl.id);
        }

        // turns → new turns, loop_id remapped, mapping old id → new id.
        const turns = await (db.fork_get_turns as PrepMethod).all<{ id: number; loop_id: number; [k: string]: unknown }>({ run_id: parentRunId });
        const turnMap = new Map<number, number>();
        for (const { id, loop_id, ...rest } of turns) {
            // #254 — a fork inherits the parent's log for context but spends no new money:
            // the copied turns are history, not fresh generations. Zero their usage so the
            // cost-rollup triggers add nothing — the session total stays true lifetime spend
            // (no double-count) and the branch's cost_pico accrues only what IT generates.
            const nt = await (db.fork_insert_turn as PrepMethod).get<{ id: number }>({
                ...rest, usage_prompt: 0, usage_completion: 0, usage_cached: 0, usage_cost_pico: 0,
                loop_id: loopMap.get(loop_id),
            });
            if (nt === undefined) throw new Error("fork: turn insert returned no row");
            turnMap.set(id, nt.id);
        }

        // entries → new entries: run/loop/turn ids remapped; fold-state and
        // attribution and content all preserved.
        const entries = await (db.fork_get_log_entries as PrepMethod).all<{ loop_id: number; turn_id: number; [k: string]: unknown }>({ run_id: parentRunId });
        for (const e of entries) {
            await (db.fork_insert_log_entry as PrepMethod).run({ ...e, run_id: branchRunId, loop_id: loopMap.get(e.loop_id), turn_id: turnMap.get(e.turn_id) });
        }

        // §run-scheme — inherit the parent's run-scope SCRATCH, owner remapped (parent → branch) in
        // the pathname so the branch's private workspace is independent and diverges on its own edits.
        const parentPrefix = `/${parent.name}/`;
        const branchPrefix = `/${branchName}/`;
        const scratch = await (db.fork_get_run_scope_entries as PrepMethod).all<{ id: number; scheme: string; pathname: string; deep_hash: string | null; attributes: string }>(
            { session_id: parent.session_id, owner_prefix: `${parentPrefix}*` },
        );
        for (const s of scratch) {
            const newPathname = branchPrefix + s.pathname.slice(parentPrefix.length);
            const ne = await (db.fork_insert_run_scope_entry as PrepMethod).get<{ id: number }>(
                { session_id: parent.session_id, scheme: s.scheme, pathname: newPathname, deep_hash: s.deep_hash, attributes: s.attributes },
            );
            if (ne === undefined) throw new Error("fork: run-scope entry copy returned no row");
            await (db.fork_copy_entry_channels as PrepMethod).run({ old_entry_id: s.id, new_entry_id: ne.id });
            await (db.fork_copy_entry_tags as PrepMethod).run({ old_entry_id: s.id, new_entry_id: ne.id });
        }

        return branchRunId;
    }
}
