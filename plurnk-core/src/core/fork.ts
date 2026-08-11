// Fork a worker — branch the log, share the workspace (SPEC {§machine-processes}).
//
// A fork is a new worker in the same workspace (`parent_worker_id` records the lineage),
// holding a deep copy of the parent's log: loops → turns → entries, with their
// fold-state (`expanded`) and attribution (`origin`/`source`) intact. It copies
// nothing of the shared WORLD — commons-owned entries and the overlay are shared, never
// copied, because the worker never owned them. It DOES inherit the parent's private
// entries ({§worker-scheme}, owner-remapped parent → branch):
// "fork = everything-in-common-but-name, then diverges". Its ambient observation
// cursor is copied with that inherited history, then diverges independently.

import type { Db } from "./Db.ts";
import WorkerName, { type WorkerOrigin } from "./WorkerName.ts";

export default class Fork {
    // Terminal loop statuses ({§lifecycle-terms}) — inherited loops outside this set are clamped to 200.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    static async fork(db: Db, parentWorkerId: number, name?: string): Promise<number> {
        const parent = await db.fork_get_worker.get<{
            workspace_id: number;
            name: string;
            origin: WorkerOrigin;
            ambient_event_cursor: number | null;
        }>({ id: parentWorkerId });
        if (parent === undefined) throw new Error(`fork: worker ${parentWorkerId} not found`);

        // {§worker-scheme-fork}, {§machine-processes-worker-origin} — name the branch at instantiation
        // (immutable after). An explicit name wins; the default
        // is the next free `<parent>-fork-<N>` admitted by {§worker-name-minting}.
        const branch = name === undefined
            ? await WorkerName.claimAuto(db, {
                workspaceId: parent.workspace_id,
                prefix: parent.name,
                qualifier: "fork",
                parentWorkerId,
                origin: parent.origin,
            })
            : await db.fork_insert_worker.get<{ id: number }>({
                workspace_id: parent.workspace_id,
                name: WorkerName.assert(name),
                parent_worker_id: parentWorkerId,
                origin: parent.origin,
            });
        if (branch === undefined) throw new Error("fork: explicit branch worker insert returned no row");
        const branchWorkerId = branch.id;
        await db.fork_set_ambient_cursor.run({
            worker_id: branchWorkerId,
            ambient_event_cursor: parent.ambient_event_cursor,
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
            flags: string;
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
                flags: l.flags,
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
            // history but no physical provider-request rows. Branch accounting
            // therefore begins with only requests it actually issues.
            const nt = await db.fork_insert_turn.get<{ id: number }>({
                ...rest,
                loop_id: loopMap.get(loop_id),
            });
            if (nt === undefined) throw new Error("fork: turn insert returned no row");
            turnMap.set(id, nt.id);
        }

        // entries → new entries: worker/loop/turn ids remapped; fold-state and
        // attribution and content all preserved.
        const entries = await db.fork_get_log_entries.all<{ id: number; loop_id: number; turn_id: number; [k: string]: unknown }>({ worker_id: parentWorkerId });
        const logMap = new Map<number, number>();
        for (const e of entries) {
            const { id: oldLogId, ...row } = e;
            const ne = await db.fork_insert_log_entry.get<{ id: number }>({ ...row, worker_id: branchWorkerId, loop_id: loopMap.get(e.loop_id), turn_id: turnMap.get(e.turn_id) });
            if (ne === undefined) throw new Error("fork: log entry copy returned no row");
            logMap.set(oldLogId, ne.id);
            // {§log-region-tagging} — carry the row's region tags onto the copy (no-op when untagged).
            await db.fork_copy_log_tags.run({ old_log_id: oldLogId, new_log_id: ne.id });
        }
        const curationEffects = await db.fork_get_log_curation_effects.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            expanded_before: 0 | 1;
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
                expanded_before: effect.expanded_before,
            });
        }

        // {§worker-scheme} — inherit the parent's private scratch: same pathnames, the BRANCH as owner
        // ({§entry-owner} — ownership is the column, never the pathname), so the branch's private
        // workspace is independent and diverges on its own edits.
        const scratch = await db.fork_get_private_entries.all<{ id: number; scheme: string; pathname: string; deep_hash: string | null; attributes: string }>(
            { workspace_id: parent.workspace_id, owner_id: parentWorkerId },
        );
        for (const s of scratch) {
            const ne = await db.fork_insert_private_entry.get<{ id: number }>(
                { workspace_id: parent.workspace_id, owner_id: branchWorkerId, scheme: s.scheme, pathname: s.pathname, deep_hash: s.deep_hash, attributes: s.attributes },
            );
            if (ne === undefined) throw new Error("fork: private entry copy returned no row");
            await db.fork_copy_entry_channels.run({ old_entry_id: s.id, new_entry_id: ne.id });
            await db.fork_copy_entry_tags.run({ old_entry_id: s.id, new_entry_id: ne.id });
        }

        return branchWorkerId;
    }
}
