import test from "node:test";
import assert from "node:assert/strict";
import Jsonplurnk from "../Jsonplurnk.ts";

// {§jsonplurnk} Three entries, the middle one `open` with a
// heredoc body whose TAG is a `prompt://` URI (colons and slashes).
const SAMPLE = `[
{"kind":"model_emission","path":"log:///1/1/1","status":200,"tokens":109,"display":"folded"},
{"op":"READ","path":"log:///1/1/3/READ","status":200,"target":"prompt:///2/1","range":{"unit":"line","total":12,"requested":[1,12],"returned":[1,12]},"tokens":545,"display":"open","body":
<<:::prompt:///2/1
1:\tImprove ABS module loading so \`require()\` remains deterministic
:::prompt:///2/1
},
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
    // The heredoc content is every line between opener and delimiter, so the newline before
    // `:::TAG` belongs to the body (bash heredoc semantics).
    assert.equal(parsed[1].body, "1:\tImprove ABS module loading so `require()` remains deterministic\n");
});

test("jsonplurnk: a no-body block is already valid JSON and passes through untouched", () => {
    const block = `[
{"kind":"model_emission","path":"log:///1/1/1","status":200,"tokens":109,"display":"folded"},
{"op":"FIND","path":"log:///1/1/2/FIND","status":200,"range":{"unit":"resource","total":0,"requested":[1,16]},"tokens":0,"display":"none","body":""}
]`;
    assert.equal(Jsonplurnk.strip(block), block);
    assert.equal((Jsonplurnk.parse(block) as any[]).length, 2);
});

test("jsonplurnk: a `:::wrongTag` line inside the body does not close it early", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<<:::log:///1/1/1/READ
a line
:::log:///9/9/9/DECOY
still the same body
:::log:///1/1/1/READ
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].body, /:::log:\/\/\/9\/9\/9\/DECOY/);
    assert.match(parsed[0].body, /still the same body/);
});

test("jsonplurnk: a `:::TAG` line with trailing characters does not close", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<<:::log:///1/1/1/READ
:::log:///1/1/1/READ-not-really
real close below
:::log:///1/1/1/READ
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.match(parsed[0].body, /READ-not-really/);
    assert.match(parsed[0].body, /real close below/);
});

test("jsonplurnk: inner `\"body\":` and `<<:::` text in content is content, not a new opener", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<<:::log:///1/1/1/READ
here is a doc that shows "body":
<<:::inner-example
that never gets treated as an opener
:::log:///1/1/1/READ
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].body, /shows "body":/);
    assert.match(parsed[0].body, /<<:::inner-example/);
});

test("jsonplurnk: an empty body recovers as the empty string", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<<:::log:///1/1/1/READ
:::log:///1/1/1/READ
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed[0].body, "");
});

test("jsonplurnk: an unterminated body throws a specific error, not silent bad JSON", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<<:::log:///1/1/1/READ
a line that never closes
}
]`;
    assert.throws(() => Jsonplurnk.strip(block), /jsonplurnk: unterminated body <<:::log:\/\/\/1\/1\/1\/READ/);
});
