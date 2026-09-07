import test from "node:test";
import assert from "node:assert/strict";
import StrikeRail from "./StrikeRail.ts";
import { parsePath, type BareStatement, type ExecStatement, type ReadStatement } from "@plurnk/plurnk-contracts";

test("network query and channel coordinates remain distinct cycle fingerprints", () => {
    const statement = (raw: string): ReadStatement => ({
        op: "READ",
        delimiter: "",
        annotation: null,
        target: parsePath(raw),
        metadata: null,
        lineMarker: null,
        body: null,
        position: { line: 1, column: 1 },
    });
    const first = StrikeRail.fingerprintTurn([statement("https://example.org/x?a=1&b=2#body")]);
    const reordered = StrikeRail.fingerprintTurn([statement("https://example.org/x?b=2&a=1#body")]);
    const channel = StrikeRail.fingerprintTurn([statement("https://example.org/x?a=1&b=2#header")]);
    assert.notEqual(first, reordered);
    assert.notEqual(first, channel);
});

test("EXEC bodies that share a long boilerplate prefix remain distinct cycle activities", () => {
    // run25 (gemini-3.8-flash, 2026-09-03): five consecutive turns paged routing.py with the same
    // python3 preamble and different line ranges; a 64-character body prefix called that a cycle.
    const pager = (from: number, to: number): ExecStatement => ({
        op: "EXEC",
        delimiter: "0",
        annotation: null,
        metadata: null,
        executor: null,
        target: null,
        lineMarker: null,
        body: `python3 -c '\nwith open("fastapi/routing.py") as f:\n    lines = f.readlines()\nfor i in range(${from}, ${to}):\n    print(lines[i], end="")\n'`,
        position: { line: 1, column: 1 },
    });
    assert.notEqual(StrikeRail.fingerprintTurn([pager(480, 560)]), StrikeRail.fingerprintTurn([pager(540, 640)]));
    assert.equal(StrikeRail.fingerprintTurn([pager(480, 560)]), StrikeRail.fingerprintTurn([pager(480, 560)]), "the same command is still the same activity");
});

test("distinct BARE prompts remain distinct cycle activities", () => {
    const statement = (body: string): BareStatement => ({
        op: "BARE",
        delimiter: "0",
        annotation: null,
        target: null,
        metadata: null,
        lineMarker: null,
        body,
        position: { line: 1, column: 1 },
    });
    assert.notEqual(
        StrikeRail.fingerprintTurn([statement("What is the capital of Germany?")]),
        StrikeRail.fingerprintTurn([statement("What is the capital of France?")]),
    );
});
