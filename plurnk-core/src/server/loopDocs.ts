// The pre-loop doc materialization — ONE truth for both loop routes (legacy loop.run and the
// seam's runLoop). Two sets, both idempotent EDITs through the plurnk worker (§actor-boundary):
//   1. operator/client reference docs (PLURNK_SERVICE_MD_* ∪ settings.mdDocs, client wins on
//      collision) at plurnk:///<alias>.md — Engine.runTurn foists their READs at turn 0 (#231);
//   2. the plugin scheme/exec reference docs (#note12) at plurnk://docs/<name>.md — discovered
//      by the turn-1 FIND(plurnk://docs/**) foist (#270), the marquee first-turn feature.
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import type { PlurnkStatement, EditStatement } from "@plurnk/plurnk-grammar";
import WorkspaceSettings from "../core/workspace-settings.ts";
import DispatchAsPlurnk from "./dispatch-as-plurnk.ts";

export default class LoopDocs {
    static async materialize(engine: Engine, db: Db, workspaceId: number): Promise<void> {
        const { mdDocs } = await WorkspaceSettings.read(db, workspaceId);
        const docStmts: EditStatement[] = (await WorkspaceSettings.resolveDocs(mdDocs)).map((doc) => ({
            op: "EDIT", suffix: "", signal: null,
            target: { kind: "url", raw: `worker://plurnk/${doc.entryName}`, scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: `/${doc.entryName}`, params: {}, fragment: null },
            lineMarker: { marks: [1, -1] }, body: doc.content, position: { line: 1, column: 1 },
        }));
        for (const { name, content } of await engine.docEntries(workspaceId)) {
            docStmts.push({
                op: "EDIT", suffix: "", signal: null,
                target: { kind: "url", raw: `worker://plurnk/docs/${name}.md`, scheme: "worker", username: null, password: null, hostname: "plurnk", port: null, pathname: `/docs/${name}.md`, params: {}, fragment: null },
                lineMarker: { marks: [1, -1] }, body: content, position: { line: 1, column: 1 },
            });
        }
        if (docStmts.length > 0) await DispatchAsPlurnk.dispatch(engine, db, workspaceId, docStmts as PlurnkStatement[]);
    }
}
