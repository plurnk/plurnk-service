// Workspace documentation reconciliation. It runs when the daemon boots an existing workspace
// and when a new workspace is created, never as a per-worker or per-loop ritual. Two sets run
// through the workspace's reserved plurnk worker ({§actor-boundary}):
//   1. the project AGENTS.md at worker://plurnk/agents.md — Engine.runTurn foists
//      its READ at turn 0 ({§turn0-agents-stunt});
//   2. the exact current scheme and executable-tool reference set under
//      worker://plurnk/skills/plurnk/ and worker://plurnk/tools/ — discovered by the
//      turn-0 FIND surveys ({§schemes-self-doc-materialization},
//      {§tools-resource-materialization}).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import {
    UNKNOWN_POSITION,
    type EditStatement,
    type ParsedPath,
    type PlurnkStatement,
    type SendStatement,
} from "@plurnk/plurnk-contracts";
import Owner from "../core/Owner.ts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

export default class LoopDocs {
    // {§schemes-self-doc-materialization} {§tools-resource-materialization} —
    // the generated-skill surface tracks a content signature so repeated
    // boot/module-publish materializations dispatch nothing when nothing
    // changed (the entry layer's 304 no-op never even runs).
    static #signatures = new WeakMap<object, Map<number, string>>();

    static evict(db: Db, workspaceId: number): void {
        LoopDocs.#signatures.get(db)?.delete(workspaceId);
    }

    static #target(pathname: string): ParsedPath {
        return {
            kind: "url",
            raw: `worker://plurnk${pathname}`,
            scheme: "worker",
            username: null,
            password: null,
            hostname: "plurnk",
            port: null,
            pathname,
            query: null,
            fragment: null,
        };
    }

    static async materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const statements: PlurnkStatement[] = [];
        const ownerId = await Owner.kernelId(db, workspaceId);

        // {§turn0-agents-stunt} — the project's AGENTS.md becomes one
        // kernel-owned worker://plurnk/agents.md entry, foisted at turn 0.
        // Absent file retires an EXISTING entry; nothing is ever 410'd blind.
        const workspace = await db.envelope_get_workspace.get<{ project_root: string | null }>({
            id: workspaceId,
        });
        const agentsContent = workspace?.project_root === null || workspace?.project_root === undefined
            ? null
            : await readFile(join(workspace.project_root, "AGENTS.md"), "utf8").catch(() => null);
        const agentsEntry = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId,
            owner_id: ownerId,
            scheme: "worker",
            pathname: "/agents.md",
        });
        if (agentsContent === null) {
            if (agentsEntry !== undefined) {
                statements.push({
                    op: "SEND", delimiter: "", annotation: null, signal: 410,
                    target: LoopDocs.#target("/agents.md"),
                    lineMarker: null, body: null, position: UNKNOWN_POSITION,
                } satisfies SendStatement);
            }
        } else {
            statements.push({
                op: "EDIT", delimiter: "", annotation: null, signal: null,
                target: LoopDocs.#target("/agents.md"),
                lineMarker: { marks: [1, -1] }, body: agentsContent, position: UNKNOWN_POSITION,
            } satisfies EditStatement);
        }

        const desiredDocs = new Map(
            (await engine.referenceEntries(workspaceId)).map(({ pathname, content }) => [pathname, content]),
        );
        const materializedDocs = await db.loop_docs_materialized.all<{ pathname: string }>({
            workspace_id: workspaceId,
            owner_id: ownerId,
        });
        for (const { pathname } of materializedDocs) {
            if (desiredDocs.has(pathname)) continue;
            statements.push({
                op: "SEND", delimiter: "", annotation: null, signal: 410,
                target: LoopDocs.#target(pathname),
                lineMarker: null, body: null, position: UNKNOWN_POSITION,
            } satisfies SendStatement);
        }
        for (const [pathname, content] of desiredDocs) {
            statements.push({
                op: "EDIT", delimiter: "", annotation: null, signal: null,
                target: LoopDocs.#target(pathname),
                lineMarker: { marks: [1, -1] }, body: content, position: UNKNOWN_POSITION,
            });
        }

        const signature = createHash("sha256")
            .update(agentsContent ?? "\u0000")
            .update([...desiredDocs].map(([pathname, content]) => `${pathname}\u0000${content}`).join("\u0001"))
            .digest("hex");
        const byWorkspace = LoopDocs.#signatures.get(db) ?? new Map<number, string>();
        if (byWorkspace.get(workspaceId) === signature) return;
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, statements);
        byWorkspace.set(workspaceId, signature);
        LoopDocs.#signatures.set(db, byWorkspace);
    }
}
