import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";

const statements = (source: string) => PlurnkParser.parse(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const advisories = (source: string) => PlurnkParser.parse(source).items.flatMap((item) => item.kind === "error" ? [item.error.message] : []);

test("{§log-kill-distillation} a log KILL keeps its body as the distillation of what it retires", () => {
    const source = "```KILL (log:///1/[1-7]/*/{NOTE,READ}) <!-- retires the rows; the body stays as a NOTE -->\nwcs.py: _array_converter short-circuits empty input; fix the return path.\n```\n";
    const [kill] = statements(source);
    assert.equal(kill?.op, "KILL");
    if (kill?.op !== "KILL") return;
    assert.equal(kill.target?.kind === "url" ? kill.target.scheme : null, "log");
    assert.equal(kill.body, "wcs.py: _array_converter short-circuits empty input; fix the return path.");
    assert.equal(kill.aside, "retires the rows; the body stays as a NOTE");
    assert.equal(kill.matcher, null, "a distillation is never read as a matcher");
    assert.deepEqual(advisories(source), [], "no advisory: the body is admitted");
});

test("{§log-kill-distillation} a scoped log KILL keeps its scope and its distillation", () => {
    const [kill] = statements("```KILL (log:///1/[8-9]/*/READ) <17,-1> <!-- keeps lines 1–16 of each -->\nLines 17+ were the unrelated fixtures.\n```\n");
    assert.equal(kill?.op, "KILL");
    if (kill?.op !== "KILL") return;
    assert.deepEqual(kill.lineMarker, { marks: [17, -1] });
    assert.equal(kill.body, "Lines 17+ were the unrelated fixtures.");
});

test("{§log-kill-distillation} a pattern option and a distillation ride one log KILL; an inline pattern still lifts", () => {
    const [withOption] = statements("```KILL (log:///1/**) [{\"pattern\": \"~stale\"}]\nThe stale reads said nothing new.\n```\n");
    assert.equal(withOption?.op, "KILL");
    if (withOption?.op !== "KILL") return;
    assert.equal(withOption.matcher?.raw, "~stale");
    assert.equal(withOption.body, "The stale reads said nothing new.");
    const [inline] = statements("```KILL (log:///1/**) ~stale\n```\n");
    assert.equal(inline?.op === "KILL" ? inline.matcher?.raw : null, "~stale", "a sigil on the heading line is the matcher");
    assert.equal(inline?.op === "KILL" ? inline.body : "?", null);
});

test("{§kill-scope} a body beneath any other targeted KILL still draws the advisory and is dropped", () => {
    const source = "```KILL (sh:///ab3d5678)\nstop it\n```\n";
    const [kill] = statements(source);
    assert.equal(kill?.op === "KILL" ? kill.body : "?", null);
    assert.match(advisories(source)[0] ?? "", /KILL with a target takes no body/u);
});

test("{§kill-conclusion} the parameterless KILL is unchanged: its body is the answer and it ends the turn", () => {
    const [kill, ...rest] = statements("```KILL\nDone.\n```READ (x.md)\n```\n```\n");
    assert.equal(kill?.op, "KILL");
    assert.equal(kill?.op === "KILL" ? kill.body : "?", "Done.\n```READ (x.md)\n```", "a heading inside the answer is literal text ({§terminal-kill})");
    assert.deepEqual(rest.map(({ op }) => op), []);
});
