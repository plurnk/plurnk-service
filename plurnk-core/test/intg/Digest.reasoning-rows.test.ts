import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { testArtifactDirectory } from "../../../scripts/test-artifacts.ts";
import Digest from "../../src/digest/Digest.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const KNOB = "PLURNK_SERVICE_REASONING_ROWS";
const withKnob = async (value: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env[KNOB];
    if (value === undefined) delete process.env[KNOB]; else process.env[KNOB] = value;
    try { await fn(); } finally { if (previous === undefined) delete process.env[KNOB]; else process.env[KNOB] = previous; }
};

test("{§reasoning-row} {§digest-forensic-fidelity}: the digest counts reasoning rows, their curation, and excludes them from op mix", async () => {
    await withKnob("1", async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "reasoning-rows-digest-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````READ (worker:///test.txt)````", reasoning: "First turn thinking." } },
            { assistant: { content: "````KILL (log:///1/2/2/reasoning)````", reasoning: "Second turn thinking." } },
            { assistant: { content: "````KILL\nDone.\n````", reasoning: "Third turn thinking." } },
        ] });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "reasoning-rows-digest");
            const workerId = await insertWorker(db, workspaceId, null, "analyst");
            const loopId = await insertLoop(db, workerId, 1, "Investigate and curate reasoning.");
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const run = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 4, messages: [{ role: "user", content: "Start." }] });
            assert.equal(run.result.status, 200);
        } finally {
            await db.close();
        }
        Digest.run({ dbPath, digestDir });

        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        // 3 reasoning rows landed, 1 was killed by turn 2
        assert.match(report, /^Reasonings: 3 landed · 1 killed$/mu);
        assert.match(report, /← \[_plurnk\] reasoning \(killed\)\[200\] reasoning:\/\/analyst\/1\/2$/mu);
        assert.match(report, /← \[_plurnk\] reasoning\[200\] reasoning:\/\/analyst\/1\/3$/mu);
        // Op mix must NOT count the 3 reasoning READs (only the 1 model-authored READ from turn 1!)
        const mix = /^Op mix: {5}(.*)$/mu.exec(report)?.[1] ?? "";
        assert.match(mix, /\bREAD=1\b/u, "harness reasoning rows are excluded from the model op mix");
    });
});

test("{§reasoning-row} {§digest-forensic-fidelity}: when reasoning rows are disabled, reasoned turns are reported as unbudgeted or disabled", async () => {
    await withKnob("0", async () => {
        const dir = await mkdtemp(join(await testArtifactDirectory("core"), "reasoning-rows-disabled-"));
        const dbPath = join(dir, "plurnk.db");
        const digestDir = join(dir, "digest");
        const provider = new Mock({ contextWindow: 100_000, responses: [
            { assistant: { content: "````KILL\nDone.\n````", reasoning: "Thinking occurred." } },
        ] });
        const db = await openMigrated(dbPath);
        try {
            const workspaceId = await insertWorkspace(db, "reasoning-disabled-digest");
            const workerId = await insertWorker(db, workspaceId, null, "analyst");
            const loopId = await insertLoop(db, workerId, 1, "Quick finish.");
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const run = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 2, messages: [{ role: "user", content: "Start." }] });
            assert.equal(run.result.status, 200);
        } finally {
            await db.close();
        }
        Digest.run({ dbPath, digestDir });

        const report = await readFile(join(digestDir, "digest.md"), "utf8");
        assert.match(report, /^Reasonings: 0 of 1 landed \(unbudgeted or disabled\)$/mu);
    });
});
