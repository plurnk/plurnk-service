// #377 — §tokenomics-window-unpollable-deliberate: "CTX stands in for unknown physics" only when
// deliberate. An unpollable window (provider.contextSize null) riding BARE partition numbers is
// nobody's policy — fail loud at first use, naming both remedies. A per-alias knob (either the
// window or the partition) makes the stand-in deliberate and the build proceeds.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";

const nullWindowMock = () => new Mock({ contextSize: null, responses: [{ assistant: { content: "", reasoning: null, ops: [] } }] });

test("[§tokenomics-window-unpollable-deliberate] null window + bare partition numbers → legible refusal naming both remedies (#377)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `unpollable-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await assert.rejects(
            () => engine.runTurn({ provider: nullWindowMock(), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] }),
            /unpollable.*bare numbers|nobody chose/s,
            "the refusal names the condition",
        );
        await assert.rejects(
            () => engine.runTurn({ provider: nullWindowMock(), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] }),
            /PLURNK_PROVIDERS_CONTEXT_SIZE|PLURNK_SERVICE_\{CTX/s,
            "the refusal names the remedies",
        );
    } finally { await db.close(); }
});

test("[§tokenomics-window-unpollable-deliberate] a per-alias partition knob makes the stand-in DELIBERATE — the build proceeds", async () => {
    // The active test alias is 'mocktest' (test/setup.ts); a per-alias CTX marks its envelope chosen.
    process.env.PLURNK_SERVICE_CTX_mocktest = "8192";
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `deliberate-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.runTurn({ provider: nullWindowMock(), sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.ok(r.turnId > 0, "the turn builds — the operator's per-alias CTX stands in deliberately");
    } finally {
        delete process.env.PLURNK_SERVICE_CTX_mocktest;
        await db.close();
    }
});
