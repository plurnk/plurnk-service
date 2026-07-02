// §tokenomics-ceiling-calibrates-to-usage (#311) — the ceiling divides by the loop's observed
// real/measured token ratio, learned from the provider's own usage.prompt. A chars/4 ruler on
// escaped-JSON logs undercounts ~1.5×; without calibration the grinder's honest arithmetic
// shipped a 65k-real packet into gemma's 49k window.

import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// A Mock whose reported prompt usage is a fixed multiple of whatever we measured — the
// undercounting-ruler scenario: real tokens = measured × ratio.
class UndercountedMock extends Mock {
    #ratio: number;
    constructor(opts: ConstructorParameters<typeof Mock>[0] & { ratio: number }) {
        super(opts);
        this.#ratio = opts.ratio;
    }
    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        const res = await super.generate(args);
        const measured = args.messages.reduce((n, m) => n + this.countTokens(m.content), 0);
        return { ...res, assistant: { ...res.assistant, usage: { ...res.assistant.usage, prompt: Math.round(measured * this.#ratio), total: 0 } } };
    }
}

const resp = (ops: PlurnkStatement[]): MockResponse => ({ assistant: { content: "", reasoning: null, ops } });

test("[§tokenomics-ceiling-calibrates-to-usage] the next turn's ceiling divides by the observed real/measured ratio", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `calib-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // The provider reports its prompts cost 2× what our ruler measured (window 100k → raw ceiling 90k).
        const provider = new UndercountedMock({ contextSize: 100000, ratio: 2, responses: [resp([sendStmt(102, null, "1")]), resp([sendStmt(200, null, "done")])] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet), "budget");
        const ceiling = Number(/Token Ceiling (\d+)/.exec(budget)?.[1]);
        // Turn 2's ceiling ≈ 90000/2 — the measured packet may now only claim half the window,
        // so the REAL request (2× our measure) can never exceed it. Small drift allowed: the
        // observed ratio includes the wire join overhead our per-slot measure doesn't.
        assert.ok(ceiling <= 45000, `ceiling calibrated down from 90000; got ${ceiling}`);
        assert.ok(ceiling >= 40000, `calibration is the observed ~2×, not runaway shrink; got ${ceiling}`);
    } finally { await db.close(); }
});

test("[§tokenomics-ceiling-calibrates-to-usage] an accurate ruler keeps its full ceiling — the ratio floors at 1", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `calib-flat-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // Mock's own usage reporting (prompt: 0) never claims MORE than measured → no shrink.
        const provider = new Mock({ contextSize: 100000, responses: [resp([sendStmt(102, null, "1")]), resp([sendStmt(200, null, "done")])] });
        await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const t2 = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId }))!.packet), "budget");
        assert.match(budget, /Token Ceiling 90000/, "the raw ceiling stands for an honest ruler");
    } finally { await db.close(); }
});
