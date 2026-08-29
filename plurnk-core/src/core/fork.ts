// Fork a worker — branch the log, share the workspace (SPEC {§machine-processes}).
//
// A fork is a new worker in the same workspace (`parent_worker_id` records the lineage),
// holding a deep copy of the parent's log: loops → turns → entries, with their
// durable log evidence and current projection with attribution (`origin`/`source`) intact. It copies
// nothing of the shared WORLD — commons-owned entries and the overlay are shared, never
// copied, because the worker never owned them. Worker-owned entries follow the
// registered scheme's explicit inheritance disposition; only quiescent snapshots
// are owner-remapped parent → branch. Its ambient observation cursor is copied
// with inherited history, then diverges independently.

import type { Db } from "./Db.ts";
import WorkerName, { type WorkerOrigin } from "./WorkerName.ts";
import { isGeneratedPathname } from "./plurnk-uri.ts";
import type { CapabilityPolicy, ReasoningPolicy } from "@plurnk/plurnk-contracts";
import type { SchemeEntryInheritance } from "@plurnk/plurnk-schemes";

type EntryInheritance = (storedScheme: string) => SchemeEntryInheritance;

export default class Fork {
    // Terminal loop statuses ({§lifecycle-terms}) — inherited loops outside this set are clamped to 200.
    static #TERMINAL_LOOP = new Set([200, 413, 429, 499, 500, 504, 508]);

    static async fork(
        db: Db,
        parentWorkerId: number,
        name: string | undefined,
        capabilityBound: CapabilityPolicy,
        entryInheritance: EntryInheritance,
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
                forkSnapshot: true,
                capabilityBound,
            })
            : await db.fork_insert_worker.get<{ id: number }>({
                workspace_id: parent.workspace_id,
                name: WorkerName.assert(name),
                parent_worker_id: parentWorkerId,
                origin: parent.origin,
                fork_snapshot: 1,
                capability_bound: JSON.stringify(capabilityBound),
            });
        if (branch === undefined) throw new Error("fork: explicit branch worker insert returned no row");
        const branchWorkerId = branch.id;
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
            [k: string]: unknown;
        }>({ worker_id: parentWorkerId });
        const logMap = new Map<number, number>();
        for (const e of entries) {
            const { id: oldLogId, projection_active, projection_folded, ...row } = e;
            const ne = await db.fork_insert_log_entry.get<{ id: number }>({ ...row, worker_id: branchWorkerId, loop_id: loopMap.get(e.loop_id), turn_id: turnMap.get(e.turn_id) });
            if (ne === undefined) throw new Error("fork: log entry copy returned no row");
            await db.fork_set_log_entry_projection.run({
                log_entry_id: ne.id,
                active: projection_active,
                folded: projection_folded,
            });
            logMap.set(oldLogId, ne.id);
            // {§log-item-tags} — carry the row's classifications onto the copy (no-op when untagged).
            await db.fork_copy_log_tags.run({ old_log_id: oldLogId, new_log_id: ne.id });
        }
        const curationEffects = await db.fork_get_log_curation_effects.all<{
            operation_log_entry_id: number;
            target_log_entry_id: number;
            active_before: 0 | 1;
            active_after: 0 | 1;
            folded_before: string;
            folded_after: string;
            tags_added: string;
            tags_removed: string;
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
                tags_added: effect.tags_added,
                tags_removed: effect.tags_removed,
            });
        }

        // {§machine-processes-entry-inheritance} — only a scheme-declared,
        // quiescent snapshot crosses the fork. Live resources retain no phantom
        // callback, and rederived/omitted entries carry no accidental bytes.
        const ownedEntries = await db.fork_get_private_entries.all<{
            id: number;
            scheme: string;
            authority: string;
            pathname: string;
            attributes: string;
            active: 0 | 1;
        }>(
            { owner_id: parentWorkerId },
        );
        for (const s of ownedEntries) {
            if (s.active === 1 || entryInheritance(s.scheme) !== "snapshot") continue;
            // {§worker-generated-subtree} — the child rederives Plurnk-generated
            // documents from its inherited Functionality instead of inheriting bytes.
            if (s.scheme === "worker" && isGeneratedPathname(s.pathname)) continue;
            const ne = await db.fork_insert_private_entry.get<{ id: number }>(
                {
                    workspace_id: parent.workspace_id,
                    owner_id: branchWorkerId,
                    scheme: s.scheme,
                    authority: s.authority,
                    pathname: s.pathname,
                    attributes: s.attributes,
                },
            );
            if (ne === undefined) throw new Error("fork: private entry copy returned no row");
            await db.fork_copy_entry_channels.run({ old_entry_id: s.id, new_entry_id: ne.id });
        }

        return branchWorkerId;
    }
}
