// Fork a worker — branch the log, share the workspace (SPEC {§machine-processes}).
// Named scratch and evidence snapshot under {§machine-processes-entry-inheritance}.

import type { Db } from "./Db.ts";
import WorkerName, { type WorkerOrigin } from "./WorkerName.ts";
import type { ReasoningPolicy } from "@plurnk/plurnk-contracts";

export default class Fork {
    // Terminal loop statuses ({§lifecycle-terms}) — inherited loops outside this set are clamped to 200.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    static async fork(
        db: Db,
        parentWorkerId: number,
        name: string | undefined,
    ): Promise<number> {
        const parent = await db.fork_get_worker.get<{
            workspace_id: number;
            name: string;
            origin: WorkerOrigin;
            model_route_id: number | null;
            spawn_model_route_id: number | null;
            reasoning_policy: ReasoningPolicy | null;
        }>({ id: parentWorkerId });
        if (parent === undefined) throw new Error(`fork: worker ${parentWorkerId} not found`);

        // {§worker-auto-name} The same allocator serves addressless WORK and FORK.
        const branch = name === undefined
            ? await WorkerName.claimAuto(db, {
                workspaceId: parent.workspace_id,
                parentWorkerId,
                origin: parent.origin,
                forkSnapshot: true,
            })
            : await WorkerName.claimNamed(db, name, {
                workspaceId: parent.workspace_id,
                parentWorkerId,
                origin: parent.origin,
                forkSnapshot: true,
            });
        const branchWorkerId = branch.id;
        const branchName = await WorkerName.forId(db, branchWorkerId);
        await db.fork_set_generation_policy.run({
            worker_id: branchWorkerId,
            model_route_id: parent.model_route_id,
            spawn_model_route_id: parent.spawn_model_route_id,
            reasoning_policy: parent.reasoning_policy,
        });

        // loops → new loops, mapping old id → new id. A copied loop is INHERITED HISTORY, never the
        // branch's live work (its own loop is enqueued fresh by injectWorker) — so a non-terminal status
        // is clamped to terminal (200). Otherwise a fork taken while the parent's loop is mid-flight (102)
        // would carry a frozen-live loop no drain ever advances, falsely marking the branch forever-live
        // to any liveness check ({§worker-scheme-fork}, the premature-terminate gate {§send-premature-terminate}).
        const loops = await db.fork_get_loops.all<{
            id: number;
            sequence: number;
            status: number;
            prompt: string;
            policy: string;
            model_route_id: number | null;
            spawn_model_route_id: number | null;
            reasoning_policy: ReasoningPolicy | null;
            max_turns: number;
            terminal_result: string | null;
        }>({ worker_id: parentWorkerId });
        const loopMap = new Map<number, number>();
        for (const l of loops) {
            const status = Fork.#TERMINAL_LOOP.has(l.status) ? l.status : 200;
            const terminalResult = Fork.#TERMINAL_LOOP.has(l.status)
                ? l.terminal_result
                : JSON.stringify({ status: 200 });
            if (terminalResult === null) {
                throw new Error(`fork: terminal source loop ${l.id} has no durable result`);
            }
            const nl = await db.fork_insert_loop.get<{ id: number }>({
                worker_id: branchWorkerId,
                sequence: l.sequence,
                status,
                prompt: l.prompt,
                policy: l.policy,
                model_route_id: l.model_route_id,
                spawn_model_route_id: l.spawn_model_route_id,
                reasoning_policy: l.reasoning_policy,
                max_turns: l.max_turns,
                terminal_result: terminalResult,
            });
            if (nl === undefined) throw new Error("fork: loop insert returned no row");
            await db.fork_reidentify_loop_result.run({ loop_id: nl.id });
            loopMap.set(l.id, nl.id);
        }

        // turns → new turns, loop_id remapped, mapping old id → new id.
        const turns = await db.fork_get_turns.all<{ id: number; loop_id: number; [k: string]: unknown }>({ worker_id: parentWorkerId });
        const turnMap = new Map<number, number>();
        for (const { id, loop_id, ...rest } of turns) {
            // {§machine-processes-fork-cost} — copied turns retain conversational
            // history, while model calls, admission rows, and physical requests
            // remain owned by the source worker. Branch accounting therefore
            // begins with only calls it actually issues.
            const nt = await db.fork_insert_turn.get<{ id: number }>({
                ...rest,
                loop_id: loopMap.get(loop_id),
            });
            if (nt === undefined) throw new Error("fork: turn insert returned no row");
            await db.fork_copy_turn_sources.run({ old_turn_id: id, new_turn_id: nt.id });
            turnMap.set(id, nt.id);
        }

        // entries → new entries: worker/loop/turn ids remapped; visibility and
        // attribution and content all preserved.
        const entries = await db.fork_get_log_entries.all<{
            id: number;
            loop_id: number;
            turn_id: number;
            projection_active: 0 | 1;
            projection_folded: string;
            output_admission_turn_id: number | null;
            output_withheld: number;
            [k: string]: unknown;
        }>({ worker_id: parentWorkerId });
        const logMap = new Map<number, number>();
        for (const e of entries) {
            const { id: oldLogId, projection_active, projection_folded, output_admission_turn_id, output_withheld, ...row } = e;
            const ne = await db.fork_insert_log_entry.get<{ id: number }>({ ...row, worker_id: branchWorkerId, loop_id: loopMap.get(e.loop_id), turn_id: turnMap.get(e.turn_id) });
            if (ne === undefined) throw new Error("fork: log entry copy returned no row");
            await db.fork_set_log_entry_projection.run({
                log_entry_id: ne.id,
                active: projection_active,
                folded: projection_folded,
                output_admission_turn_id: output_admission_turn_id === null ? null : turnMap.get(output_admission_turn_id),
                output_withheld,
            });
            logMap.set(oldLogId, ne.id);
        }
        const curationEffects = await db.fork_get_log_curation_effects.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: 0 | 1;
            active_after: 0 | 1;
            folded_before: string;
            folded_after: string;
        }>({ worker_id: parentWorkerId });
        for (const effect of curationEffects) {
            const operationLogEntryId = logMap.get(effect.operation_log_entry_id);
            const targetLogEntryId = logMap.get(effect.target_log_entry_id);
            if (operationLogEntryId === undefined || targetLogEntryId === undefined) {
                throw new Error("fork: curation effect references a log row outside copied history");
            }
            await db.fork_insert_log_curation_effect.run({
                operation_log_entry_id: operationLogEntryId,
                target_log_entry_id: targetLogEntryId,
                active_before: effect.active_before,
                active_after: effect.active_after,
                folded_before: effect.folded_before,
                folded_after: effect.folded_after,
            });
        }

        // {§machine-processes-entry-inheritance}: live producers cannot be copied.
        const namedEntries = await db.fork_get_scratch_entries.all<{
            id: number;
            scheme: string;
            authority: string;
            pathname: string;
            attributes: string;
            active: 0 | 1;
        }>(
            { worker_id: parentWorkerId },
        );
        for (const s of namedEntries) {
            if (s.active === 1) continue;
            const ne = await db.fork_insert_scratch_entry.get<{ id: number }>(
                {
                    workspace_id: parent.workspace_id,
                    scheme: s.scheme,
                    authority: branchName,
                    pathname: s.pathname,
                    attributes: s.attributes,
                },
            );
            if (ne === undefined) throw new Error("fork: named entry copy returned no row");
            await db.fork_copy_entry_channels.run({ old_entry_id: s.id, new_entry_id: ne.id });
        }

        return branchWorkerId;
    }
}
