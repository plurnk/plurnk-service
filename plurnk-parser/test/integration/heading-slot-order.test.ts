// {§heading-slot-order} — recorded heading near-misses read as their one reading (#758).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const parse = (input: string) => PlurnkParser.parse(input, { executors: ["sh"] });
const errors = (input: string) => parse(input).items.filter((item) => item.kind === "error");
const same = (nearMiss: string, canonical: string) => {
    const strip = (input: string) => parse(input).items.map((item) => item.kind === "statement" ? { ...item.statement, position: undefined } : item);
    assert.deepEqual(errors(nearMiss), [], nearMiss);
    assert.deepEqual(strip(nearMiss), strip(canonical), nearMiss);
};

test("{§heading-slot-order} an aside before the remaining slots reads as if written after them", () => {
    same("````READ (worker:///pantry/alpha.md) <!-- verify content --> <1,-1>\n````", "````READ (worker:///pantry/alpha.md) <1,-1> <!-- verify content -->\n````");
    same("````FIND (worker:///pantry/**) <!-- re-confirm pantry state --> <1,-1>\n````", "````FIND (worker:///pantry/**) <1,-1> <!-- re-confirm pantry state -->\n````");
    same("````sh <-1,2> <!-- full suite --> [{\"cwd\": \"tests\"}]\npytest -q\n````", "````sh <-1,2> [{\"cwd\": \"tests\"}] <!-- full suite -->\npytest -q\n````");
});

test("{§heading-slot-order} zero-width characters on a heading line are skipped", () => {
    same("````READ (fastapi/applications.py) <1564,1640> <!-- app.get signature -->\u200d````", "````READ (fastapi/applications.py) <1564,1640> <!-- app.get signature -->````");
});

test("{§heading-slot-order} a backtick-quoted sigil matcher is that matcher; quoted plain text stays refused", () => {
    same("````FIND (tests/test_x.py) <1,-1> `^def test_`\n````", "````FIND (tests/test_x.py) <1,-1> ^def test_\n````");
    same("````EDIT (world.ts) `^        reset\\(\\) \\{$`\n        reset() {\n````", "````EDIT (world.ts) ^        reset\\(\\) \\{$\n        reset() {\n````");
    assert.ok(errors("````READ (a.md) `plain`\n````").length > 0);
});

test("{§heading-slot-order} an aside followed by a target or a non-JSON block keeps its place and stays refused", () => {
    assert.ok(errors("````sh <!-- Lists issues --> [gitea] (list_issues)\n{}\n````").length > 0);
    assert.ok(errors("````READ (a.md) <!-- why --> (b.md)\n````").length > 0);
});
