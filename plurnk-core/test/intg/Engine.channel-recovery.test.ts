import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertSession, insertLoop } from "./_db.ts";

const response = (operation: string, op = "NOTE") => ({
    assistant: { content: `${operation}
\`\`\`\`${op}
\`\`\`\``, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

test("{§channel-selection-missing} channel exploration across operation owners permits recovery without strikes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `channel-recovery-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Retrieve the retained text.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const misses = [
            "````READ (workspace:///note#stdout)````",
            "````FIND (workspace:///note#stderr)````",
            "````COPY (workspace:///note#results) (workspace:///copy)````",
            "````COPY (workspace:///note) (workspace:///copy#results)````",
            "````MOVE (workspace:///note#stdout) (workspace:///moved)````",
            "````MOVE (workspace:///note) (workspace:///moved#stdout)````",
            "````EDIT (workspace:///note#extra) <1>\nreplacement\n````",
            "````EDIT (workspace:///note#constructor) <1>\nreplacement\n````",
        ];
        const provider = new Mock({ contextWindow: 100000, responses: [
            response("````EDIT (workspace:///note)\nretained text\n````"),
            ...misses.map((operation) => response(operation)),
            response("````READ (workspace:///note)````"),
            { assistant: { content: "````SEND [200]\nRetrieved the retained text.\n````", reasoning: null } },
        ] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 15 });
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
        const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const failures = rows.filter(({ status_rx }) => status_rx >= 400);
        assert.deepEqual(failures.map(({ op, status_rx }) => ({ op, status_rx })),
            ["READ", "FIND", "COPY", "COPY", "MOVE", "MOVE", "EDIT", "EDIT"].map((op) => ({ op, status_rx: 404 })));
        for (const { op, rx } of failures) {
            const problem = JSON.parse(rx).problem;
            assert.match(problem.type, /\/channel-not-found$/);
            // A READ miss names the channels the entry holds; the other owners name the scheme's
            // declared channels, which include the derived `readable` ({§readable-channel}).
            assert.deepEqual(problem.availableChannels, op === "READ" ? ["body"] : ["body", "readable"]);
        }
        const recovered = rows.find(({ op, pathname, status_rx }) => op === "READ" && pathname === "/note" && status_rx === 200);
        assert.ok(recovered);
        assert.match(JSON.parse(recovered.rx).content, /retained text/);
        assert.equal(await db.test_get_entry_by_path.get({ workspace_id: workspaceId, scheme: "workspace", pathname: "/copy" }), undefined);
        assert.equal(await db.test_get_entry_by_path.get({ workspace_id: workspaceId, scheme: "workspace", pathname: "/moved" }), undefined);
    } finally { await db.close(); }
});
