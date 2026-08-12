import test from "node:test";
import assert from "node:assert/strict";
import Jsonplurnk from "../Jsonplurnk.ts";

// {§jsonplurnk} Three entries, the middle one `open` with a BODY enclosure.
const SAMPLE = `[
{"kind":"model_emission","path":"log:///1/1/1","status":200,"tokens":109,"display":"folded"},
{"op":"READ","path":"log:///1/1/3/READ","status":200,"target":"prompt:///2/1","range":{"unit":"line","total":12,"requested":[1,12],"returned":[1,12]},"tokens":545,"display":"open","body":
<|BODY>
1:\tImprove ABS module loading so \`require()\` remains deterministic
<BODY|>
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
    // Content is every line between the BODY boundaries, so the newline before
    // `<BODY|>` belongs to the body.
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

test("jsonplurnk: a non-BODY close line inside the body does not close it early", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<|BODY>
a line
<DECOY|>
still the same body
<BODY|>
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].body, /<DECOY\|>/);
    assert.match(parsed[0].body, /still the same body/);
});

test("jsonplurnk: a `<BODY|>` line with trailing characters does not close", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<|BODY>
<BODY|>-not-really
real close below
<BODY|>
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.match(parsed[0].body, /<BODY\|>-not-really/);
    assert.match(parsed[0].body, /real close below/);
});

test("jsonplurnk: inner `\"body\":` and `<|BODY>` text is content, not a new opener", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<|BODY>
here is a doc that shows "body":
<|BODY>
that never gets treated as an opener
<BODY|>
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed.length, 1);
    assert.match(parsed[0].body, /shows "body":/);
    assert.match(parsed[0].body, /<\|BODY>/);
});

test("jsonplurnk: an empty body recovers as the empty string", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<|BODY>
<BODY|>
}
]`;
    const parsed = Jsonplurnk.parse(block) as any[];
    assert.equal(parsed[0].body, "");
});

test("jsonplurnk: an unterminated body throws a specific error, not silent bad JSON", () => {
    const block = `[
{"op":"READ","path":"log:///1/1/1/READ","display":"open","body":
<|BODY>
a line that never closes
}
]`;
    assert.throws(() => Jsonplurnk.strip(block), /jsonplurnk: unterminated body <\|BODY>/);
});
