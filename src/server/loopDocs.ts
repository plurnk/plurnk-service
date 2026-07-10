// The pre-loop doc materialization — ONE truth for both loop routes (legacy loop.run and the
// seam's runLoop). Two sets, both idempotent EDITs through the plurnk run (§actor-boundary):
//   1. operator/client reference docs (PLURNK_SERVICE_MD_* ∪ settings.mdDocs, client wins on
//      collision) at plurnk:///<alias>.md — Engine.runTurn foists their READs at turn 0 (#231);
//   2. the daughter scheme/exec reference docs (#note12) at plurnk://docs/<name>.md — discovered
//      by the turn-1 FIND(plurnk://docs/**) foist (#270), the marquee first-turn feature.
import type Engine from "../core/Engine.ts";
import type { Db } from "../core/Db.ts";
import type { PlurnkStatement, EditStatement } from "@plurnk/plurnk-grammar";
import SessionSettings from "../core/session-settings.ts";
import DispatchAsPlurnk from "./methods/_dispatchAsPlurnk.ts";

export default class LoopDocs {
    static async materialize(engine: Engine, db: Db, sessionId: number): Promise<void> {
        const { mdDocs } = await SessionSettings.read(db, sessionId);
        const docStmts: EditStatement[] = (await SessionSettings.resolveDocs(mdDocs)).map((doc) => ({
            op: "EDIT", suffix: "", signal: null,
            target: { kind: "url", raw: `plurnk:///${doc.entryName}`, scheme: "plurnk", username: null, password: null, hostname: null, port: null, pathname: `/${doc.entryName}`, params: {}, fragment: null },
            lineMarker: null, body: doc.content, position: { line: 1, column: 1 },
        }));
        for (const { name, content } of await engine.docEntries(sessionId)) {
            docStmts.push({
                op: "EDIT", suffix: "", signal: null,
                target: { kind: "url", raw: `plurnk://docs/${name}.md`, scheme: "plurnk", username: null, password: null, hostname: "docs", port: null, pathname: `/${name}.md`, params: {}, fragment: null },
                lineMarker: null, body: content, position: { line: 1, column: 1 },
            });
        }
        if (docStmts.length > 0) await DispatchAsPlurnk.dispatch(engine, db, sessionId, docStmts as PlurnkStatement[]);
    }
}
