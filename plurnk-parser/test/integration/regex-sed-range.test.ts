import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

// {§matcher-refusal} — the refusal rides the admitted statement's matcher.
const errorOf = (source: string): string => {
    const statements = PlurnkParser.parse(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    const matcher = statements[0] !== undefined && "matcher" in statements[0] ? statements[0].matcher : null;
    assert.ok(matcher !== null && matcher !== undefined && matcher.dialect === "unreadable", source);
    return matcher.dialect === "unreadable" ? matcher.message : "";
};

for (const matcher of ["/^def start/,/^def end/", "/start/, /end/", "/start/,+45", "/start/,"]) {
    test(`{§regex-sed-range} {§diagnostic-observation} ${matcher} reports its range suffix without rewriting it`, () => {
        assert.equal(errorOf(`\`\`\`\`READ (example.py) ${matcher}\`\`\`\``),
            "Regex matcher contains a range suffix after its closing `/`.");
    });
}

test("{§regex-sed-range} genuinely invalid flags keep the native failure", () => {
    assert.match(errorOf("````FIND (src/**) /x/z````"), /Invalid flags supplied to RegExp constructor 'z'/u);
});
