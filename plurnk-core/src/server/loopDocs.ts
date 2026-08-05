// Workspace documentation reconciliation. It runs when the daemon boots an existing workspace
// and when a new workspace is created, never as a per-worker or per-loop ritual. Two sets, both
// idempotent EDITs through the workspace's reserved plurnk worker ({§actor-boundary}):
//   1. operator/client reference docs (PLURNK_SERVICE_MD_* ∪ settings.mdDocs, client wins on
//      collision) at worker://plurnk/<alias>.md — Engine.runTurn foists their READs at turn 0
//      ({§operator-config-workspace-md-docs});
//   2. plugin scheme/exec reference docs at worker://plurnk/docs/<name>.md — discovered
//      by the turn-0 FIND(worker://plurnk/docs/**) foist (#270).
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import { UNKNOWN_POSITION, type PlurnkStatement, type EditStatement } from "@plurnk/plurnk-contracts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

export default class LoopDocs {
    static async materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const { mdDocs } = await WorkspaceSettings.read(db, workspaceId);
        const docStmts: EditStatement[] = (await WorkspaceSettings.resolveDocs(mdDocs)).map((doc) => ({
            op: "EDIT", suffix: "", signal: null,
            target: { kind: "url", raw: `worker://plurnk/${doc.entryName}`, scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: `/${doc.entryName}`, query: null, fragment: null },
            lineMarker: { marks: [1, -1] }, body: doc.content, position: UNKNOWN_POSITION,
        }));
        for (const { name, content } of await engine.docEntries(workspaceId)) {
            docStmts.push({
                op: "EDIT", suffix: "", signal: null,
                target: { kind: "url", raw: `worker://plurnk/docs/${name}.md`, scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: `/docs/${name}.md`, query: null, fragment: null },
                lineMarker: { marks: [1, -1] }, body: content, position: UNKNOWN_POSITION,
            });
        }
        if (docStmts.length > 0) await DispatchAsPlurnk.dispatch(engine, db, workspaceId, docStmts as PlurnkStatement[]);
    }
}
