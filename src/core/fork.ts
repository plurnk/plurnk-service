// Fork a run — branch the log, share the session (SPEC §machine-processes).
//
// A fork is a NEW run in the SAME session (`parent_run_id` records the lineage),
// holding a deep copy of the parent's log: loops → turns → entries, with their
// fold-state (`indexed`) and attribution (`origin`/`source`) intact. It copies
// nothing of the world — the session's entries and overlay are shared, never
// copied, because a run never owned them. The §env-delta reconciliation snapshot is
// not copied either; the branch first-sights its world like any fresh run.

import type { Db, PrepMethod } from "./Db.ts";

export default class Fork {
    static async fork(db: Db, parentRunId: number): Promise<number> {
        const parent = await (db.fork_get_run as PrepMethod).get<{ session_id: number; name: string; origin: string }>({ id: parentRunId });
        if (parent === undefined) throw new Error(`fork: run ${parentRunId} not found`);

        const branch = await (db.fork_insert_run as PrepMethod).get<{ id: number }>({
            session_id: parent.session_id, name: `${parent.name}-fork`, parent_run_id: parentRunId, origin: parent.origin,
        });
        if (branch === undefined) throw new Error("fork: branch run insert returned no row");
        const branchRunId = branch.id;

        // loops → new loops, mapping old id → new id.
        const loops = await (db.fork_get_loops as PrepMethod).all<{ id: number; sequence: number; status: number; prompt: string; flags: string }>({ run_id: parentRunId });
        const loopMap = new Map<number, number>();
        for (const l of loops) {
            const nl = await (db.fork_insert_loop as PrepMethod).get<{ id: number }>({ run_id: branchRunId, sequence: l.sequence, status: l.status, prompt: l.prompt, flags: l.flags });
            if (nl === undefined) throw new Error("fork: loop insert returned no row");
            loopMap.set(l.id, nl.id);
        }

        // turns → new turns, loop_id remapped, mapping old id → new id.
        const turns = await (db.fork_get_turns as PrepMethod).all<{ id: number; loop_id: number; [k: string]: unknown }>({ run_id: parentRunId });
        const turnMap = new Map<number, number>();
        for (const { id, loop_id, ...rest } of turns) {
            const nt = await (db.fork_insert_turn as PrepMethod).get<{ id: number }>({ ...rest, loop_id: loopMap.get(loop_id) });
            if (nt === undefined) throw new Error("fork: turn insert returned no row");
            turnMap.set(id, nt.id);
        }

        // entries → new entries: run/loop/turn ids remapped; fold-state and
        // attribution and content all preserved.
        const entries = await (db.fork_get_log_entries as PrepMethod).all<{ loop_id: number; turn_id: number; [k: string]: unknown }>({ run_id: parentRunId });
        for (const e of entries) {
            await (db.fork_insert_log_entry as PrepMethod).run({ ...e, run_id: branchRunId, loop_id: loopMap.get(e.loop_id), turn_id: turnMap.get(e.turn_id) });
        }

        return branchRunId;
    }
}
