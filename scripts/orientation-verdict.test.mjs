import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOrientation } from "./orientation-verdict.mjs";

const record = {
    schemaVersion: 1,
    response: `The daemon in plurnk-core/src/service.ts orchestrates the platform, while
plurnk-contracts/README.md owns the DSL and repo/plurnk/README.md documents the client.
The repository topology is a monorepo plus outside repositories. The current stabilization and
acceptance goal is tracked in #583. A missing live issue feed is a remaining context gap.`,
    finalStatus: 200,
    hitMaxTurns: false,
    timedOut: false,
    usage: { costUsd: 42 },
    turns: [{
        turn: 1,
        ops: [
            { op: "FIND", target: "**", status: 200 },
            { op: "READ", target: "plurnk-core/src/service.ts", status: 200 },
            { op: "READ", target: "plurnk-contracts/README.md", status: 200 },
            { op: "READ", target: "repo/plurnk/README.md", status: 200 },
        ],
    }],
};

const digest = {
    workers: [{ id: 1, name: "plurnk" }, { id: 2, name: "meta" }],
    loops: [{ id: 1, worker_id: 1 }, { id: 2, worker_id: 2 }],
    turns: [
        { id: 1, loop_id: 1, model: null },
        { id: 2, loop_id: 2, model: "endpoint/model" },
    ],
    log_entries: [
        { turn_id: 1, op: "EDIT", status_rx: 201 },
        { turn_id: 2, op: "READ", status_rx: 200 },
    ],
};

test("orientation verdict accepts a terminal, inspected, evidence-bearing report", () => {
    const verdict = evaluateOrientation(record, digest);
    assert.equal(verdict.pass, true);
    assert.deepEqual(verdict.failed, []);
    assert.equal(verdict.model, "endpoint/model");
    assert.equal(verdict.costUsd, 42);
});

test("orientation verdict rejects a plausible answer that did not inspect its evidence", () => {
    const shallow = structuredClone(record);
    shallow.turns = [{ turn: 1, ops: [{ op: "FIND", target: "**", status: 200 }] }];
    const verdict = evaluateOrientation(shallow, digest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("inspection"));
    assert.ok(verdict.failed.includes("evidence"));
});

test("orientation verdict rejects failed documentation publication independently of model success", () => {
    const broken = structuredClone(digest);
    broken.log_entries.push({ turn_id: 1, op: "EDIT", status_rx: 400 });
    const verdict = evaluateOrientation(record, broken);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("workspacePublication"));
});

test("orientation verdict rejects timeout, missing coverage, and empty delivery", () => {
    const failed = { ...record, response: "", timedOut: true, finalStatus: 499 };
    const verdict = evaluateOrientation(failed, digest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("lifecycle"));
    assert.ok(verdict.failed.includes("coverage"));
});

test("orientation verdict rejects a generic stabilization narrative that misses the live housekeeping epic", () => {
    const stale = { ...record, response: record.response.replace("#583", "the README") };
    const verdict = evaluateOrientation(stale, digest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("coverage"));
});
