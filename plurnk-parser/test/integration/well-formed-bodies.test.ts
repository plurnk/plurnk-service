// {§pairing-objective}: a body its runtime declares a media type for is read where it is well-formed in it.
import test from "node:test";
import assert from "node:assert/strict";
import PlurnkParser from "../../src/PlurnkParser.ts";

const json = (runtime: string, body: string): boolean => {
    if (runtime !== "gitea") return true;
    try { JSON.parse(body); return true; } catch { return false; }
};
const bodies = (source: string, wellFormed?: typeof json) => PlurnkParser.parse(source, { executors: ["gitea"], ...(wellFormed === undefined ? {} : { wellFormed }) }).items
    .flatMap((item) => {
        if (item.kind !== "statement" || !("body" in item.statement)) return [];
        const { body } = item.statement;
        return [typeof body === "string" ? body : (body as { raw?: string } | null)?.raw ?? null];
    });

// An MCP call, then prose that later shows a bare block of its own.
const SOURCE = [
    "So I can invoke:", "", "```gitea (list_issues)", "{\"owner\": \"plurnk\", \"repo\": \"plurnk-service\"}", "```", "",
    "But I need owner/repo first.", "", "```", "git remote -v", "```", "", "Let me check.",
].join("\n");

test("{§pairing-objective}: a JSON-bodied call ends at its own closer when the longer reading is not JSON", () => {
    assert.deepEqual(bodies(SOURCE, json), ["{\"owner\": \"plurnk\", \"repo\": \"plurnk-service\"}"]);
});

test("{§pairing-objective}: a trailing aside is the writer's, and does not make a JSON body malformed", () => {
    const source = SOURCE.replace("\"plurnk-service\"}", "\"plurnk-service\"} <!-- open issues -->");
    assert.deepEqual(bodies(source, json), ["{\"owner\": \"plurnk\", \"repo\": \"plurnk-service\"} <!-- open issues -->"]);
});

test("{§pairing-objective}: a runtime with no declared media type keeps the fence-only reading", () => {
    const [body] = bodies(SOURCE);
    assert.ok(body!.includes("git remote -v"), "without a check the call keeps its nested reading");
});

test("{§heading-inline-body}: an executor's heading object is input for both a JSON tool and a shell", () => {
    const parse = (source: string) => PlurnkParser.parse(source, { executors: ["sh", "gitea"] }).items;
    const statement = (source: string) => parse(source).flatMap((item) => item.kind === "statement" ? [item.statement as { metadata: readonly string[] | null; body: unknown }] : [])[0]!;
    const warnings = (source: string) => parse(source).flatMap((item) => item.kind === "error" ? [item.error.message] : []);
    const mcp = "```gitea (list_issues) {\"owner\":\"plurnk\"}\n```";
    assert.deepEqual([statement(mcp).metadata, statement(mcp).body], [null, "{\"owner\":\"plurnk\"}"], "an MCP tool's heading object is its arguments body");
    assert.deepEqual(warnings(mcp), ["`gitea` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line."]);
    const shell = "```sh {\"cwd\":\"/tmp\"}\nls\n```";
    assert.deepEqual([statement(shell).metadata, statement(shell).body], [null, "{\"cwd\":\"/tmp\"}\nls"], "unbracketed input is not promoted to authority-bearing metadata");
    assert.deepEqual(warnings(shell), ["`sh` body text was on the OP line and was taken as the body; body content goes immediately beneath the opening fence line."]);
    const bracketed = "```sh [{\"stdin\":\"open\"}]\ncat\n```";
    assert.deepEqual([statement(bracketed).metadata, statement(bracketed).body], [["{\"stdin\":\"open\"}"], "cat"]);
    assert.deepEqual(warnings(bracketed), []);
});
