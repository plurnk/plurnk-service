import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOrientation } from "./orientation-verdict.mjs";

const record = {
    schemaVersion: 1,
    response: `The daemon in plurnk-service/plurnk-core/src/service.ts orchestrates the platform, while
plurnk-service/plurnk-contracts/README.md owns the DSL and outside-client/README.md documents the client.
The repository topology is a monorepo plus outside repositories. No canonical forge issue feed
was available, so the current stabilization goal is unverified; that missing context limits confidence.`,
    finalStatus: 200,
    hitMaxTurns: false,
    timedOut: false,
    usage: { costUsd: 42 },
    turns: [{
        turn: 1,
        ops: [
            { op: "FIND", target: "**", status: 200 },
            { op: "READ", target: "plurnk-service/plurnk-core/src/service.ts", status: 200 },
            { op: "READ", target: "plurnk-service/plurnk-contracts/README.md", status: 200 },
            { op: "READ", target: "outside-client/README.md", status: 200 },
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

test("orientation verdict does not count archived issue URLs as inspected repository evidence", () => {
    const archaeological = {
        ...record,
        response: record.response
            .replace("plurnk-service/plurnk-core/src/service.ts", "https://github.com/plurnk/plurnk-service/issues/583")
            .replace("plurnk-service/plurnk-contracts/README.md", "https://github.com/plurnk/plurnk-service/issues/585")
            .replace("outside-client/README.md", "https://github.com/plurnk/plurnk-service/issues/621"),
    };
    const verdict = evaluateOrientation(archaeological, digest);
    assert.equal(verdict.pass, false);
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

test("orientation verdict rejects a report that omits current-forge evidence availability", () => {
    const stale = {
        ...record,
        response: record.response.replace(
            /No canonical forge issue feed[\s\S]*?limits confidence\./,
            "The architecture appears stable.",
        ),
    };
    const verdict = evaluateOrientation(stale, digest);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failed.includes("coverage"));
});
