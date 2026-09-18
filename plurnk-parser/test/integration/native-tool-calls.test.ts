// {§native-tool-calls} — recorded DSML emissions read as the operations they name (#760).
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const EXECUTORS = ["sh", "node"];
const read = (input: string) => PlurnkParser.parse(input, { executors: EXECUTORS });
const ops = (input: string) => read(input).items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
const canonical = (fence: string) => PlurnkParser.parse(fence, { executors: EXECUTORS }).items.flatMap((item) => item.kind === "statement" ? [{ ...item.statement, position: undefined }] : []);
const withoutPosition = <T extends object>(statements: T[]) => statements.map((statement) => ({ ...statement, position: undefined }));

test("{§native-tool-calls} a DSML READ with path and scope parameters is that READ (engine-edit-probe-kSoo0p)", () => {
    const input = [
        "<｜｜DSML｜｜ calls>",
        "<｜｜DSML｜｜ invoke name=\"READ\">",
        "<｜｜DSML｜｜ parameter name=\"path\" string=\"true\">Engine.ts</｜｜DSML｜｜ parameter>",
        "<｜｜DSML｜｜ parameter name=\"scope\" string=\"true\">440,470</｜｜DSML｜｜ parameter>",
        "</｜｜DSML｜｜ invoke>",
        "</｜｜DSML｜｜ calls>",
    ].join("\n");
    assert.deepEqual(read(input).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(withoutPosition(ops(input)), canonical("````READ (Engine.ts) <440,470>\n````"));
});

test("{§native-tool-calls} a DSML WAIT naming a worker and a DSML sh with a verbatim heading and plain body lines", () => {
    const wait = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"WAIT\">", "<parameter name=\"path\">worker://codename-lookup</｜｜DSML｜｜ parameter>", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(withoutPosition(ops(wait)), canonical("````WAIT (worker://codename-lookup)\n````"));

    const sh = [
        "<｜｜DSML｜｜ calls>",
        "<｜｜DSML｜｜ invoke name=\"sh\" [{\"cwd\":\".\"}] <!-- rebuild and re-run -->",
        "go build . && echo ROOT_OK",
        "```",
        "",
        "<｜｜DSML｜｜ calls>",
        "<｜｜DSML｜｜ invoke name=\"WAIT\" <!-- await the build -->",
        "</｜｜DSML｜｜ parameter>",
        "</｜｜DSML｜｜ invoke>",
        "</｜｜DSML｜｜ calls>",
    ].join("\n");
    const statements = ops(sh);
    assert.deepEqual(read(sh).items.filter((item) => item.kind === "error"), []);
    assert.deepEqual(withoutPosition(statements), canonical("````sh [{\"cwd\":\".\"}] <!-- rebuild and re-run -->\ngo build . && echo ROOT_OK\n````\n\n````WAIT <!-- await the build -->\n````"));
    assert.deepEqual(statements.map((statement) => statement.position?.line), [2, 7], "positions still name the source lines");
});

test("{§native-tool-calls} an unknown invoke or parameter, or markup beside a real operation, is left as it was", () => {
    const unknownName = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"36\">", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(ops(unknownName), []);
    const unknownParameter = ["<｜｜DSML｜｜ calls>", "<｜｜DSML｜｜ invoke name=\"READ\">", "<｜｜DSML｜｜ parameter name=\"height\">3</｜｜DSML｜｜ parameter>", "</｜｜DSML｜｜ invoke>", "</｜｜DSML｜｜ calls>"].join("\n");
    assert.deepEqual(ops(unknownParameter), []);
    const beside = "````READ (a.md)\n````\n\n<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name=\"READ\" path=\"b.md\" />\n</｜｜DSML｜｜ calls>";
    assert.deepEqual(ops(beside).map((statement) => "target" in statement ? statement.target?.raw : null), ["a.md"]);
});
