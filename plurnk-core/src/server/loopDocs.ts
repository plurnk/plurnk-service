// Workspace documentation reconciliation. It runs when the daemon boots an existing workspace
// and when a new workspace is created, never as a per-worker or per-loop ritual. Two sets run
// through the workspace's reserved plurnk worker ({§actor-boundary}):
//   1. operator/client reference docs (PLURNK_SERVICE_MD_* ∪ settings.mdDocs, client wins on
//      collision) at worker://plurnk/<alias>.md — Engine.runTurn foists their READs at turn 0
//      ({§operator-config-workspace-md-docs});
//   2. the exact current scheme and executable-tool reference set under
//      worker://plurnk/docs/ and worker://plurnk/tools/ — discovered by the
//      turn-0 FIND surveys ({§schemes-self-doc-materialization},
//      {§tools-resource-materialization}).
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import {
    UNKNOWN_POSITION,
    type EditStatement,
    type ParsedPath,
    type PlurnkStatement,
    type SendStatement,
} from "@plurnk/plurnk-contracts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import Owner from "../core/Owner.ts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

export default class LoopDocs {
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
        const { mdDocs } = await WorkspaceSettings.read(db, workspaceId);
        const statements: PlurnkStatement[] = (await WorkspaceSettings.resolveDocs(mdDocs)).map((doc): EditStatement => ({
            op: "EDIT", delimiter: "", annotation: null, signal: null,
            target: LoopDocs.#target(`/${doc.entryName}`),
            lineMarker: { marks: [1, -1] }, body: doc.content, position: UNKNOWN_POSITION,
        }));

        const desiredDocs = new Map(
            (await engine.referenceEntries(workspaceId)).map(({ pathname, content }) => [pathname, content]),
        );
        const ownerId = await Owner.kernelId(db, workspaceId);
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
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, statements);
    }
}
