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

// The dogfood shape (2026-09-26): an MCP call, then prose that later shows a bare block of its own.
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
