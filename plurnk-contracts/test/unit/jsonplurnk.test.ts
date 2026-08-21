import test from "node:test";
import assert from "node:assert/strict";
import Jsonplurnk from "../Jsonplurnk.ts";

// {§jsonplurnk} Three entries, the middle one `open` with a raw multiline string.
const SAMPLE = `[
{"kind":"turnOps","path":"log:///1/1/1","status":200,"tokens":109,"display":"folded"},
{"op":"READ","path":"log:///1/1/3/READ","status":200,"target":"prompt:///2/1","range":{"unit":"line","total":12,"requested":[1,12],"returned":[1,12]},"tokens":545,"display":"open","body":"
1:\tImprove ABS module loading so \`require()\` remains deterministic
"},
{"op":"FIND","path":"log:///1/1/6/FIND","status":200,"target":"worker:///**","range":{"unit":"resource","total":0,"requested":[1,16]},"tokens":0,"display":"none","body":""}
]`;

test("jsonplurnk: the ratified sample strips to valid JSON (the magnum-opus shape)", () => {
    const parsed = Jsonplurnk.parse(SAMPLE) as any[];
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].display, "folded");
    assert.equal(parsed[2].display, "none");
    assert.equal(parsed[2].body, "");
    assert.equal(parsed[1].op, "READ");
    assert.match(parsed[1].body, /Improve ABS module loading/);
});

test("jsonplurnk: the open body recovers verbatim, trailing newline included", () => {
    const parsed = Jsonplurnk.parse(SAMPLE) as any[];
    assert.equal(parsed[1].body, "1:\tImprove ABS module loading so `require()` remains deterministic\n");
});

test("jsonplurnk: bounded bodies retain a chunk field after the raw multiline value", () => {
    const block = `[{
"path":"log:///1/1/1/PLAN","display":"open","body":"
1:first selected line
","chunk":"showing <1,1> of <1,2>"}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed[0].body, "1:first selected line\n");
    assert.equal(parsed[0].chunk, "showing <1,1> of <1,2>");
});

test("jsonplurnk: a no-body block is already valid JSON and passes through untouched", () => {
    const block = `[
{"kind":"turnOps","path":"log:///1/1/1","status":200,"tokens":109,"display":"folded"},
{"op":"FIND","path":"log:///1/1/2/FIND","status":200,"range":{"unit":"resource","total":0,"requested":[1,16]},"tokens":0,"display":"none","body":""}
]`;
    assert.equal(Jsonplurnk.strip(block), block);
    assert.equal((Jsonplurnk.parse(block) as any[]).length, 2);
});

test("jsonplurnk: source quotes and object-close text cannot close a numbered body line", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
41:a line
42:"}
43:"body":" remains source text after its line prefix
44:still the same body
"}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].body, /42:"}/);
    assert.match(parsed[0].body, /43:"body":"/);
    assert.match(parsed[0].body, /still the same body/);
});

test("jsonplurnk: numbered body lines may begin at any selected source line", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
900:first selected line
901:second selected line
"}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed[0].body, "900:first selected line\n901:second selected line\n");
});

test("jsonplurnk: numeric coordinates may be left-padded for stable result alignment", () => {
    const block = `[
{"op":"FIND","path":"log:///1/1/1/FIND","display":"open","body":"
  9:first result
 10:second result
"}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed[0].body, "  9:first result\n 10:second result\n");
});

test("jsonplurnk: anchored READ lines tolerate alignment spaces before the visible line number", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
@aZ09b   9:first selected line
@0Aa9Z 100:second selected line
"}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed[0].body, "@aZ09b   9:first selected line\n@0Aa9Z 100:second selected line\n");
});

test("jsonplurnk: a fused anchor and line number is not a coordinate prefix", () => {
    const block = `[{
"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
@aZ09b:900:obsolete fused prefix
"}
]`;
    assert.throws(() => Jsonplurnk.strip(block), /jsonplurnk: body line is missing its coordinate prefix/);
});

test("jsonplurnk: a non-numbered physical body line is rejected", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
1:first line
not numbered
"}
]`;
    assert.throws(() => Jsonplurnk.strip(block), /jsonplurnk: body line is missing its coordinate prefix/);
});

test("jsonplurnk: the raw multiline form cannot represent an empty body", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
"}
]`;
    assert.throws(() => Jsonplurnk.strip(block), /jsonplurnk: raw multiline body must contain a coordinate line/);
});

test("jsonplurnk: an unterminated body throws a specific error, not silent bad JSON", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":"
1:a line that never closes
`;
    assert.throws(() => Jsonplurnk.strip(block), /jsonplurnk: unterminated raw multiline body/);
});
