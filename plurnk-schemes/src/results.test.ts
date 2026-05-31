import { test } from "node:test";
import assert from "node:assert/strict";
import type { SchemeResult } from "./results.ts";
import {
    isEntryResult,
    isProposalResult,
    isPassthroughResult,
    isErrorStatus,
    schemeError,
    logCoordinate,
} from "./results.ts";

test("shape discriminator narrows each family", () => {
    const entry: SchemeResult = { shape: "entry", status: 201, entryId: 7, channel: "body" };
    const proposal: SchemeResult = { shape: "proposal", status: 202, body: "preview", diff: "@@ -1 +1 @@" };
    const passthrough: SchemeResult = { shape: "passthrough", status: 200, content: "row", mimetype: "application/json" };

    assert.equal(isEntryResult(entry), true);
    assert.equal(isProposalResult(entry), false);
    assert.equal(isPassthroughResult(entry), false);

    assert.equal(isProposalResult(proposal), true);
    assert.equal(isEntryResult(proposal), false);

    assert.equal(isPassthroughResult(passthrough), true);
    assert.equal(isProposalResult(passthrough), false);
});

test("guards are mutually exclusive and total over the union", () => {
    const results: SchemeResult[] = [
        { shape: "entry", status: 200, entryId: 1, channel: "body" },
        { shape: "proposal", status: 202 },
        { shape: "passthrough", status: 200 },
    ];
    for (const r of results) {
        const hits = [isEntryResult(r), isProposalResult(r), isPassthroughResult(r)].filter(Boolean);
        assert.equal(hits.length, 1, `exactly one guard matches ${r.shape}`);
    }
});

test("isErrorStatus marks 4xx/5xx and only those", () => {
    assert.equal(isErrorStatus(200), false);
    assert.equal(isErrorStatus(201), false);
    assert.equal(isErrorStatus(304), false);
    assert.equal(isErrorStatus(399), false);
    assert.equal(isErrorStatus(400), true);
    assert.equal(isErrorStatus(404), true);
    assert.equal(isErrorStatus(415), true);
    assert.equal(isErrorStatus(500), true);
});

test("schemeError namespaces source as scheme:<name>", () => {
    const ev = schemeError("known", "dispatch_failure", "entry not found");
    assert.equal(ev.source, "scheme:known");
    assert.equal(ev.kind, "dispatch_failure");
    assert.equal(ev.message, "entry not found");
});

test("schemeError omits absent message and position (no undefined keys)", () => {
    const ev = schemeError("exec", "validation_failure");
    assert.equal(ev.source, "scheme:exec");
    assert.equal(ev.kind, "validation_failure");
    assert.equal("message" in ev, false);
    assert.equal("position" in ev, false);
});

test("schemeError carries an explicit null message through", () => {
    const ev = schemeError("file", "strike", null);
    assert.equal("message" in ev, true);
    assert.equal(ev.message, null);
});

test("schemeError attaches a log-coordinate position", () => {
    const ev = schemeError("known", "dispatch_failure", "boom", logCoordinate("log://3/1/0", "EDIT"));
    assert.deepEqual(ev.position, { type: "log-coordinate", coordinate: "log://3/1/0", op: "EDIT" });
});

test("logCoordinate omits op when absent", () => {
    const pos = logCoordinate("log://1/2/3");
    assert.deepEqual(pos, { type: "log-coordinate", coordinate: "log://1/2/3" });
    assert.equal("op" in pos, false);
});

test("an error result carries a TelemetryEvent error envelope", () => {
    const result: SchemeResult = {
        shape: "entry",
        status: 404,
        entryId: null,
        channel: "body",
        error: schemeError("known", "dispatch_failure", "entry not found", logCoordinate("log://5/2/1", "READ")),
    };
    assert.equal(isErrorStatus(result.status), true);
    assert.equal(result.error?.source, "scheme:known");
    assert.equal(result.error?.position?.type, "log-coordinate");
});
