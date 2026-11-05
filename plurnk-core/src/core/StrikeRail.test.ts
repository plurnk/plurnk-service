import test, { describe } from "node:test";
import assert from "node:assert/strict";
import StrikeRail from "./StrikeRail.ts";
import { parsePath, PlurnkParser } from "@plurnk/plurnk-parser";
import { type BareStatement, type ExecStatement, type ReadStatement, type OperationResult } from "@plurnk/plurnk-contracts";

describe("StrikeRail", () => {
test("{§engine-rails} network query and channel coordinates remain distinct cycle fingerprints", () => {
    const statement = (raw: string): ReadStatement => ({
        op: "READ",
        aside: null,
        target: parsePath(raw),
        metadata: null,
        lineMarker: null,
        matcher: null, body: null,
        position: { line: 1, column: 1 },
    });
    const first = StrikeRail.fingerprintTurn([statement("https://example.org/x?a=1&b=2#body")]);
    const reordered = StrikeRail.fingerprintTurn([statement("https://example.org/x?b=2&a=1#body")]);
    const channel = StrikeRail.fingerprintTurn([statement("https://example.org/x?a=1&b=2#header")]);
    assert.notEqual(first, reordered);
    assert.notEqual(first, channel);
});

test("{§engine-rails} execution bodies that share a long boilerplate prefix remain distinct cycle activities", () => {
    // Paging one file with the same python3 preamble and different line ranges is not a cycle.
    const pager = (from: number, to: number): ExecStatement => ({
        runtime: "sh", aside: null,
        metadata: null,
        target: null,
        lineMarker: null,
        body: `python3 -c '\nwith open("fastapi/routing.py") as f:\n    lines = f.readlines()\nfor i in range(${from}, ${to}):\n    print(lines[i], end="")\n'`,
        position: { line: 1, column: 1 },
    });
    assert.notEqual(StrikeRail.fingerprintTurn([pager(480, 560)]), StrikeRail.fingerprintTurn([pager(540, 640)]));
    assert.equal(StrikeRail.fingerprintTurn([pager(480, 560)]), StrikeRail.fingerprintTurn([pager(480, 560)]), "the same command is still the same activity");
});

test("{§engine-rails} distinct BARE prompts remain distinct cycle activities", () => {
    const statement = (body: string): BareStatement => ({
        op: "BARE",
        aside: null,
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
});

describe("StrikeRail.activity", () => {
const statements = (source: string) => {
    const parsed = PlurnkParser.parseStatements(source);
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};
const fingerprint = (source: string, results?: readonly OperationResult[]) =>
    StrikeRail.fingerprintTurn(statements(source), results);

test("{§engine-rails} every operational operand distinguishes activity", () => {
    for (const [first, second] of [
        ['await plurnk.edit({ path: "notes.md", range: "1", content: "one" });', 'await plurnk.edit({ path: "notes.md", range: "1", content: "two" });'],
        ['await plurnk.edit({ path: "notes.md", range: "1", content: "one" });', 'await plurnk.edit({ path: "notes.md", range: "2", content: "one" });'],
        ['await plurnk.copy({ from: { path: "a", range: "1" }, to: { path: "b", range: "0" } });', 'await plurnk.copy({ from: { path: "a", range: "1" }, to: { path: "c", range: "0" } });'],
        ['await plurnk.move({ from: { path: "a", range: "1" }, to: { path: "b", range: "0" } });', 'await plurnk.move({ from: { path: "a", range: "2" }, to: { path: "b", range: "0" } });'],
        ['await plurnk.copy({ from: { path: "a", range: "1" }, to: { path: "b", range: "0" } });', 'await plurnk.copy({ from: { path: "a", range: "1" }, to: { path: "b", range: "-1" } });'],
        ['await plurnk.read({ path: "https://example.test/", metadata: [{"Accept": "text/plain"}] });', 'await plurnk.read({ path: "https://example.test/", metadata: [{"Accept": "application/json"}] });'],
        ['await plurnk.send({ target: "session://child", text: "one" });', 'await plurnk.send({ target: "session://child", text: "two" });'],
        ['await plurnk.work({ target: "session://child", prompt: "one" });', 'await plurnk.work({ target: "session://child", prompt: "two" });'],
        ['await plurnk.read({ path: "a" });\nawait plurnk.edit({ path: "b", range: "1", content: "x" });', 'await plurnk.edit({ path: "b", range: "1", content: "x" });\nawait plurnk.read({ path: "a" });'],
    ]) {
        assert.notEqual(fingerprint(first), fingerprint(second), `${first} differs from ${second}`);
    }
});

test("{§engine-rails} source decoration does not disguise a cycle", () => {
    assert.equal(fingerprint('await plurnk.read({ path: "a", range: "1" });\nawait plurnk.note({ text: "continue" });'),
        fingerprint('\nawait plurnk.read({ path: "a", range: "1" }); // another aside\nawait plurnk.note({ text: "continue" });'));
});

test("{§engine-rails} note content and lifecycle changes distinguish authored activity", () => {
    assert.notEqual(fingerprint('await plurnk.wait({ text: "Inspect." });'), fingerprint('await plurnk.note({ text: "Inspect." });'));
    assert.notEqual(fingerprint('await plurnk.note({ text: "Inspect." });'), fingerprint('await plurnk.note({ text: "Implement." });'));
});

test("{§engine-rails} a note's assigned storage coordinate does not disguise repetition", () => {
    const note = 'await plurnk.note({ text: "Retain this determination." });';
    assert.equal(fingerprint(note, [{ status: 200, resource: "note://alice/1/2/1" }]),
        fingerprint(note, [{ status: 200, resource: "note://alice/1/3/1" }]));
    assert.notEqual(fingerprint(note, [{ status: 200, resource: "note://alice/1/2/1" }]),
        fingerprint('await plurnk.note({ text: "A different determination." });', [{ status: 200, resource: "note://alice/1/3/1" }]));
    assert.notEqual(fingerprint(note, [{ status: 200, resource: "note://alice/1/2/1" }]),
        fingerprint(note, [{ status: 500 }]));
});

test("{§engine-rails} changing observations distinguish otherwise identical requests", () => {
    const source = 'await plurnk.read({ path: "notes.md" });';
    assert.notEqual(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ status: 200, content: "two" }]));
    assert.notEqual(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ status: 304 }]));
    assert.equal(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ content: "one", status: 200 }]));
});

test("{§engine-rails} engine-assigned problem instances do not conceal repeated failures", () => {
    const source = 'await plurnk.read({ path: "missing.md" });';
    const failure = (instance: string): OperationResult => ({
        status: 404,
        problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-found", title: "Not found", status: 404, detail: "No entry exists.", instance },
    });
    assert.equal(fingerprint(source, [failure("log:///1/2/2/READ")]),
        fingerprint(source, [failure("log:///1/3/2/READ")]));
    assert.notEqual(fingerprint(source, [failure("log:///1/2/2/READ")]),
        fingerprint(source, [{
            status: 404,
            problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-found", title: "Not found", status: 404, detail: "Different cause.", instance: "log:///1/3/2/READ" },
        }]));
});
});
