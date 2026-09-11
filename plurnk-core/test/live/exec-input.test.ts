import assert from "node:assert/strict";
import { liveTest as test } from "../live-test.ts";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";

test("live executor input: SEND feeds a running Node process", async (t) => {
    const s = await liveWorkspace({ name: `live-exec-input-${crypto.randomUUID()}` });
    try {
        const result = await liveLoop(s, 2, { maxTurns: 8, prompt: [
            "Exercise live input to a running process.",
            "Launch node with [{\"stdin\": \"open\"}]; its program must collect stdin and, on EOF, print that input reversed.",
            "In a later turn, SEND the exact text oranges to the returned node execution address with [{\"eof\": true}].",
            "Observe the actual process output, then report it and complete the task. Do not use a one-shot program with hardcoded input.",
        ].join("\n") }, { signal: t.signal });
        assert.equal(result.finalStatus, 200);
        assert.equal(result.hitMaxTurns, false);
        const rows = (await Promise.all(result.turnIds.map((turnId) =>
            s.db.test_log_entries_by_turn.all<{ op: string; scheme: string | null; pathname: string | null; status_rx: number; rx: string }>({ turn_id: turnId })))).flat();
        const send = rows.find((row) => row.op === "SEND" && row.scheme === "node" && row.status_rx === 200);
        assert.ok(send, "a real directed SEND reached the Node invocation");
        assert.equal(JSON.parse(send.rx).bytesAccepted, 7);
        assert.equal(JSON.parse(send.rx).inputClosed, true);
        assert.ok(send.pathname);
        const channel = await s.db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({
            pathname: send.pathname, scheme: "node", name: "stdout",
        });
        assert.equal(channel?.content.trim(), "segnaro", "the live process transformed the delivered input");
        assert.equal(channel?.state, "closed");
        assert.ok(rows.some((row) => row.op === "READ" && row.scheme === "node" && row.rx.includes("segnaro")),
            "the model received the actual output before completion");
    } finally { await s.cleanup(); }
});
