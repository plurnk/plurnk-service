import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_helpers.ts";

const response = (operation: string, status = "NEXT") => ({
    assistant: { content: `## PLAN_\n[]\n${operation}\n### SEND_ (${status})\nContinue.`, reasoning: null },
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
});

test("{§channel-selection-missing} channel exploration across operation owners permits recovery without strikes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `channel-recovery-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Retrieve the retained text.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const misses = [
            "### READ_ (worker:///note#stdout)",
            "### FIND_ (worker:///note#stderr)",
            "### COPY_ (worker:///note#results) (worker:///copy)",
            "### COPY_ (worker:///note) (worker:///copy#results)",
            "### MOVE_ (worker:///note#stdout) (worker:///moved)",
            "### MOVE_ (worker:///note) (worker:///moved#stdout)",
            "### EDIT_ (worker:///note#extra) <1>\nreplacement",
            "### EDIT_ (worker:///note#constructor) <1>\nreplacement",
        ];
        const provider = new Mock({ contextWindow: 100000, responses: [
            response("### EDIT_ (worker:///note)\nretained text"),
            ...misses.map((operation) => response(operation)),
            response("### READ_ (worker:///note)"),
            response("", "TERM"),
        ] });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], maxTurns: 15 });
        assert.equal(result.result.status, 200, JSON.stringify(result.result));
        const rows = await db.test_log_entries_by_loop.all<{ op: string; pathname: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const failures = rows.filter(({ status_rx }) => status_rx >= 400);
        assert.deepEqual(failures.map(({ op, status_rx }) => ({ op, status_rx })),
            ["READ", "FIND", "COPY", "COPY", "MOVE", "MOVE", "EDIT", "EDIT"].map((op) => ({ op, status_rx: 404 })));
        for (const { rx } of failures) {
            const problem = JSON.parse(rx).problem;
            assert.match(problem.type, /\/channel-not-found$/);
            assert.deepEqual(problem.availableChannels, ["body"]);
        }
        const recovered = rows.find(({ op, pathname, status_rx }) => op === "READ" && pathname === "/note" && status_rx === 200);
        assert.ok(recovered);
        assert.match(JSON.parse(recovered.rx).content, /retained text/);
        assert.equal(await db.test_get_entry_by_path.get({ workspace_id: workspaceId, scheme: "worker", pathname: "/copy" }), undefined);
        assert.equal(await db.test_get_entry_by_path.get({ workspace_id: workspaceId, scheme: "worker", pathname: "/moved" }), undefined);
    } finally { await db.close(); }
});
