import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { AiSdkProvider } from "@plurnk/plurnk-providers";
import type { Notice } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";

for (const transport of ["text", "wire"] as const) {
    for (const withOperation of [false, true]) {
        test(`{§native-tool-call-receipt} {§provider-native-tool-calls}: ${transport} calls withOperation=${withOperation} retain valid work and use ordinary strikes`, async () => {
            const db = await openMigrated();
            try {
                const workspaceId = await insertWorkspace(db, "native-calls");
                const workerId = await insertWorker(db, workspaceId, null, "alice");
                const loopId = await insertLoop(db, workerId, 1, "Update the fact.");
                await seedEntryWithChannel(db, { workspaceId, pathname: "/fact.txt", content: "Original fact." });
                const markup = '<tool_call><function=EDIT><parameter=old_string>Original fact.</parameter><parameter=new_string>Unadmitted change.</parameter></function></tool_call>';
                const tool = { index: 0, id: "call-1", type: "function", function: { name: "EDIT", arguments: '{"path":"worker:///fact.txt","body":"Unadmitted change."}' } };
                const operation = withOperation ? PlurnkParser.frame("EDIT (worker:///fact.txt) <1,-1>", "Admitted change.") : "";
                const content = transport === "text" ? `${operation}\n\n${markup}` : operation;
                const notices: Notice[] = [];
                let requests = 0;
                const provider = new AiSdkProvider({ model: "fixture", url: "http://example.test/v1/chat/completions", contextWindow: 100_000,
                    fetchTimeoutMs: 1000, operationTimeoutMs: 3000,
                    temperature: null, repeatPenalty: null, retryAttempts: 0, effort: { mode: "off", budget: null },
                    fetch: async () => {
                        requests += 1;
                        const first = requests === 1;
                        const delta = first ? { content, ...(transport === "wire" ? { tool_calls: [tool] } : {}) }
                            : { content: PlurnkParser.frame("KILL", "Finished.") };
                        return new Response(`data: ${JSON.stringify({
                            model: "fixture", choices: [{ index: 0, delta, finish_reason: first && transport === "wire" ? "tool_calls" : "stop" }],
                        })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
                    },
                });
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
                    noticeNotify: (_workspaceId, { notice }) => { notices.push(notice); },
                });
                const result = await engine.runLoop({ workspaceId, workerId, loopId, provider, maxTurns: 3,
                    messages: [{ role: "user", content: "Update the fact." }],
                });
                assert.equal(result.result.status, 200);
                assert.equal(requests, 2);
                assert.equal(result.turnIds.length, 3, "one inference per ordinary turn, not provider retries");
                const first = result.turnIds[1]!;
                const attempts = await db.test_turn_attempts.all<{ accepted: number }>({ turn_id: first });
                assert.deepEqual(attempts.map(({ accepted }) => accepted), [1]);
                const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string; status_rx: number }>({ turn_id: first });
                assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ status_rx }) => status_rx), withOperation ? [200] : []);
                assert.deepEqual(rows.filter(({ op }) => op === "error").map(({ rx }) => JSON.parse(rx).problem.detail),
                    withOperation ? [] : ["The turn performed no operation."]);
                const fact = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/fact.txt", scheme: "worker", name: "body" });
                assert.equal(fact?.content, withOperation ? "Admitted change." : "Original fact.");
                assert.equal(notices.filter(({ message }) => transport === "wire"
                    ? message === "The response included native tool calls, but no tools were declared."
                    : message?.includes("tool-call markup and was not executed")).length, 1);
                const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ worker_id: workerId });
                assert.equal(sources.find((row) => row.turn_id === first && row.kind === "ops")?.content ?? "", content);
            } finally { await db.close(); }
        });
    }
}
