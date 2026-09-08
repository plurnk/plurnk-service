import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import EnvDefaults from "../../src/core/env-defaults.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { insertWorker } from "./_helpers.ts";
import { copyStmt, findStmt, readStmt, regex } from "./_dsl.ts";

test("{§plurnk-skill} defaults are the operator catalog through ordinary READ and Worker enablement", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-own-skill-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await withDaemon(new Mock({ contextWindow: 32768, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        const created = await rpcCall(ws, 1, "workspace.create", { projectRoot: root });
        const workspaceId = (created.result as { id: number }).id;
        const workerId = await daemon.ensureModelWorker(workspaceId);
        const client = await insertWorker(db, workspaceId, null, "client", "client");
        const dispatch = (statement: Parameters<typeof daemon.dispatchAsClient>[0]["statement"]) =>
            daemon.dispatchAsClient({ workspaceId, workerId: client, functionalityWorkerId: workerId, statement });
        const read = (uri: string) => dispatch(readStmt(parsePath(uri), { marks: [1, -1] }));
        const catalog = await dispatch({ ...findStmt(parsePath("skill://*/SKILL.md")), lineMarker: { marks: [1, -1] } });
        assert.equal(catalog.status, 200);
        assert.match(JSON.stringify(catalog.results), /skill:\/\/plurnk\/SKILL\.md/);
        assert.doesNotMatch(JSON.stringify(catalog.results), /PLURNK_SERVICE_MAX_TURNS/,
            "catalog discovery does not inject configuration bodies");
        const entry = await read("skill://plurnk/SKILL.md");
        assert.equal(entry.status, 200);
        assert.match(String(entry.content), /name: plurnk/);
        assert.match(String(entry.content), /\.env\.defaults/);
        const defaults = await read("skill://plurnk/.env.defaults");
        assert.equal(defaults.status, 200);
        const expected = EnvDefaults.renderCatalog(await EnvDefaults.collect(resolve("."), resolve("../node_modules")));
        assert.equal(defaults.content, expected.trimEnd(), "the source matches the operator's complete installed catalog");
        const matches = await dispatch({ ...findStmt(parsePath("skill://plurnk/.env.defaults"), regex("PLURNK_PROVIDERS_OUTPUT_BUDGET")), lineMarker: { marks: [1, -1] } });
        assert.equal(matches.status, 200);
        assert.match(JSON.stringify(matches.results), /PLURNK_PROVIDERS_OUTPUT_BUDGET/);
        assert.equal((await dispatch(copyStmt(parsePath("skill://plurnk/.env.defaults")!, parsePath("worker:///defaults.md")!))).status, 201);
        assert.equal((await read("worker:///defaults.md")).content, expected.trimEnd(), "COPY consumes the generated resource through ordinary source access");
        const config = await read("skill://plurnk/references/configuration.md");
        assert.equal(config.status, 200);
        assert.equal(config.content, (await readFile("INSTALL.md", "utf8")).trimEnd(), "configuration has one package owner");
        const context = { scope: "worker" as const, workspaceId, workerId };
        const child = await daemon.forkWorker({ workspaceId, workerId });
        const childRead = () => daemon.dispatchAsClient({ workspaceId, workerId: client, functionalityWorkerId: child.workerId, statement: readStmt(parsePath("skill://plurnk/.env.defaults"), { marks: [1, 3] }) });
        assert.equal((await childRead()).status, 200, "children rederive the ordinary inherited skill");
        await daemon.invokeModuleAction("worker.skills.disable", { alias: "plurnk" }, context);
        assert.equal((await read("skill://plurnk/.env.defaults")).status, 404);
        assert.equal((await childRead()).status, 200, "later parent disablement does not change the child's selection");
        await daemon.invokeModuleAction("worker.skills.disable", { alias: "plurnk" }, { ...context, workerId: child.workerId });
        assert.equal((await childRead()).status, 404);
        await daemon.invokeModuleAction("worker.skills.enable", { alias: "plurnk" }, context);
        assert.equal((await read("skill://plurnk/.env.defaults")).status, 200);
        assert.equal((await childRead()).status, 404, "the child retains its independent disablement");

        const custom = join(root, ".agents", "skills", "plurnk");
        await mkdir(custom, { recursive: true });
        await writeFile(join(custom, "SKILL.md"), "---\nname: plurnk\ndescription: Project-owned Plurnk guidance\n---\nProject guidance.\n");
        await daemon.invokeModuleAction("worker.skills.enable", { alias: "plurnk" }, context);
        assert.match(String((await read("skill://plurnk/SKILL.md")).content), /Project guidance/);
        assert.equal((await read("skill://plurnk/.env.defaults")).status, 404, "shadowing replaces the tree, not an overlay leaking service resources");
    });
});

test("{§plurnk-skill} Turn0 catalogs the skill; only a requested READ adds defaults to the next packet", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-packet-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    class CapturingMock extends Mock {
        readonly requests: string[] = [];
        override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
            this.requests.push(args[0].messages.map(({ content }) => content).join("\n\n"));
            return super.generate(...args);
        }
    }
    const provider = new CapturingMock({ contextWindow: 32768, responses: [
        { assistant: { content: "```READ (skill://plurnk/.env.defaults) <1,3>```\n```NEXT\nInspect the reference.\n```", reasoning: null } },
        { assistant: { content: "```DONE\nReference received.\n```", reasoning: null } },
    ] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { projectRoot: root, settings: { filesItems: -1 } });
        assert.equal((await runLoopToTerminal(ws, 2, { prompt: "Inspect configuration.", policy: { proposals: "accept" } })).finalStatus, 200);
        assert.equal(provider.requests.length, 2);
        assert.match(provider.requests[0]!, /skill:\/\/plurnk\/SKILL\.md/);
        assert.doesNotMatch(provider.requests[0]!, /# Plurnk installed configuration defaults/);
        const chapterHeading = (await readFile("INSTALL.md", "utf8")).split("\n")[0]!;
        assert.ok(!provider.requests[0]!.includes(chapterHeading), "the configuration chapter is not startup teaching");
        assert.match(provider.requests[1]!, /# Plurnk installed configuration defaults/);
    });
});
