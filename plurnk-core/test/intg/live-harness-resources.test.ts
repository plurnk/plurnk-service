import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import { Mock } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { liveWorkspace, seedEntry } from "../_live-harness.ts";
import { findStmt, readStmt } from "./_dsl.ts";

test("live fixtures obey resource publication and query contracts", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const inference = t.mock.method(provider, "generate");
    const workspace = await liveWorkspace({ name: "harness-resource-publication" });
    try {
        const workerId = await workspace.daemon.ensureModelWorker(workspace.workspaceId);
        for (const content of ["alpha\nbeta\ngamma", ""]) {
            await t.test(`{§tokenomics-agnostic-ruler} ${content.length === 0 ? "empty" : "nonempty"} fixtures have their actual curation weight`, async () => {
                const entryId = await seedEntry(workspace.db, workspace.workspaceId, {
                    pathname: content.length === 0 ? "empty.md" : "lines.md", content,
                });
                const channels = await workspace.db.entry_read_channels.all<{
                    name: string; content: string; weight: number;
                }>({ entry_id: entryId });
                const body = channels.find(({ name }) => name === "body");
                assert.ok(body);
                assert.equal(body.content, content);
                assert.equal(body.weight, contentWeight(content));
            });
        }

        const html = "<html><body><h1>Welcome</h1></body></html>";
        const entryId = await seedEntry(workspace.db, workspace.workspaceId, {
            pathname: "page.html", content: html, mimetype: "text/html",
        });
        await t.test("{§readable-channel} an HTML fixture retains its source and publishes its readable sibling", async () => {
            const channels = await workspace.db.entry_read_channels.all<{
                name: string; content: string; mimetype: string; weight: number;
            }>({ entry_id: entryId });
            const source = channels.find(({ name }) => name === "body");
            assert.equal(source?.content, html);
            assert.equal(source?.mimetype, "text/html");
            const readable = channels.find(({ name }) => name === "readable");
            assert.ok(readable, "the live fixture uses the production readable projection");
            assert.match(readable.content, /Welcome/u);
            assert.equal(readable.mimetype, "text/markdown");
            assert.equal(readable.weight, contentWeight(readable.content));
        });
        await t.test("{§mimetype-query} an HTML fixture answers the live story's XPath through the real dispatcher", async () => {
            const result = await workspace.daemon.dispatchAsClient({
                workspaceId: workspace.workspaceId, workerId,
                statement: readStmt(parsePath("worker:///page.html"), { marks: [1, -1] }, {
                    dialect: "xpath", raw: "//h1",
                }),
            });
            assert.equal(result.status, 200);
            assert.equal(result.matched, 1);
            assert.match(String(result.content), /Welcome/u);
        });
        await t.test("{§readable-channel} ordinary READ keeps the fixture's source text", async () => {
            const result = await workspace.daemon.dispatchAsClient({
                workspaceId: workspace.workspaceId, workerId,
                statement: readStmt(parsePath("worker:///page.html"), { marks: [1, -1] }),
            });
            assert.equal(result.status, 200);
            assert.equal(result.content, html);
        });
        await t.test("{§mimetype-query} JSON fixtures support structural READ", async () => {
            const content = '{"answer":42}';
            await seedEntry(workspace.db, workspace.workspaceId, {
                pathname: "answer.json", content, mimetype: "application/json",
            });
            const result = await workspace.daemon.dispatchAsClient({
                workspaceId: workspace.workspaceId, workerId,
                statement: readStmt(parsePath("worker:///answer.json"), { marks: [1, -1] }, {
                    dialect: "jsonpath", raw: "$.answer",
                }),
            });
            assert.equal(result.status, 200);
            assert.equal(result.matched, 1);
            assert.equal(result.content, content);
        });
        await t.test("{§relation-indexed-dialects} fixtures enter the ordinary full-text index", async () => {
            await seedEntry(workspace.db, workspace.workspaceId, {
                pathname: "notes.md", content: "Checkpoint retention is working.",
            });
            const result = await workspace.daemon.dispatchAsClient({
                workspaceId: workspace.workspaceId, workerId,
                statement: findStmt(parsePath("worker:///notes.md"), { dialect: "fts", raw: "~checkpoint" }),
            });
            assert.equal(result.status, 200);
            assert.deepEqual(JSON.parse(String(result.content)), [{
                region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 11 }, matched: "Checkpoint",
            }]);
        });
        assert.equal(inference.mock.callCount(), 0, "publishing and inspecting fixtures requires no inference");
    } finally {
        await workspace.cleanup();
        await rm(workspace.runDir, { recursive: true, force: true });
    }
});
