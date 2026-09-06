import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Mock, chatMessageText } from "@plurnk/plurnk-providers";
import { parsePath, PlurnkParser, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { insertWorker } from "./_helpers.ts";
import { copyStmt, findStmt, readStmt, regex } from "./_dsl.ts";

class CapturingMock extends Mock {
    readonly packets: string[] = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.packets.push(args[0].messages.map(chatMessageText).join("\n\n"));
        return super.generate(...args);
    }
}

const turn = (ops: string, terminal = false) => ({
    assistant: { content: `## PLAN0\n[]\n${ops}\n### SEND0 (${terminal ? "TERM" : "NEXT"})\n${terminal ? "Done." : "Inspect results."}`, reasoning: null },
});

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("{§skills-resources} live trees preserve authority isolation, pattern composition, withdrawal and read-only ownership", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-lifecycle-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ["alpha", "beta"]) {
        const dir = join(root, ".agents", "skills", name);
        await mkdir(join(dir, "references", "nested"), { recursive: true });
        await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} fixture\n---\nRead references/guide.md.\n`);
        await writeFile(join(dir, "references", "guide.md"), `${name} current guidance\n`);
        await writeFile(join(dir, "references", "nested", "rules.md"), `${name} deep rules\n`);
        await writeFile(join(dir, "binary.bin"), Buffer.from([0, 255, 128]));
        await writeFile(join(dir, "image.png"), PNG);
    }
    await withDaemon(new Mock({ contextWindow: 32768, responses: [] }), async (db, daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        const created = await rpcCall(ws, 1, "workspace.create", { name: `skill-lifecycle-${crypto.randomUUID()}`, projectRoot: root });
        const workspaceId = (created.result as { id: number }).id;
        const model = await daemon.ensureModelWorker(workspaceId);
        const client = await insertWorker(db, workspaceId, null, "client", "client");
        const dispatch = (statement: PlurnkStatement) => daemon.dispatchAsClient({ workspaceId, workerId: client, functionalityWorkerId: model, statement });
        const find = async (target: string, body: ReturnType<typeof regex> | null = null) => {
            const result = await dispatch({ ...findStmt(parsePath(target), body), lineMarker: { marks: [1, -1] } });
            assert.equal(result.status, 200, JSON.stringify(result));
            assert.ok(Array.isArray(result.results));
            return result.results.flat() as Array<{ path: string; items?: number; summary?: string; mimetype?: string; sourceMimetype?: string }>;
        };
        assert.deepEqual((await find("skill://*/SKILL.md")).map(({ path, summary }) => ({ path, summary })), [
            { path: "skill://alpha/SKILL.md", summary: "alpha fixture" },
            { path: "skill://beta/SKILL.md", summary: "beta fixture" },
        ]);
        assert.deepEqual((await find("skill://*/references/*")).map(({ path }) => path), [
            "skill://alpha/references/guide.md", "skill://alpha/references/nested/**",
            "skill://beta/references/guide.md", "skill://beta/references/nested/**",
        ]);
        assert.deepEqual((await find("skill://{alpha,beta}/SKILL.md")).map(({ path }) => path), [
            "skill://alpha/SKILL.md", "skill://beta/SKILL.md",
        ]);
        const unknownType = await dispatch(copyStmt(parsePath("skill://alpha/binary.bin")!, parsePath("worker:///copied.bin")!));
        assert.equal(unknownType.status, 415, "an unrecognized suffix retains the destination scheme's text default");
        assert.equal((unknownType.problem as { type?: string } | undefined)?.type, "https://problems.plurnk.xyz/engine/dispatcher/mimetype-mismatch");
        const copied = await dispatch(copyStmt(parsePath("skill://alpha/image.png")!, parsePath("worker:///copied.png")!));
        assert.equal(copied.status, 201, JSON.stringify(copied));
        const bytes = await dispatch(readStmt(parsePath("worker:///copied.png"), { marks: [1, -1] }));
        assert.equal(bytes.status, 200);
        assert.equal(bytes.content, [...PNG].map((byte) => byte.toString(16).padStart(2, "0")).join("\n"), "COPY preserves source bytes across schemes");
        assert.equal((await find("skill://alpha/binary.bin"))[0]?.mimetype, "application/octet-stream");
        await writeFile(join(root, ".agents", "skills", "alpha", "binary.bin"), "Now a textual source.\n");
        const changedType = (await find("skill://alpha/binary.bin"))[0];
        assert.equal(changedType?.mimetype, "text/markdown");
        assert.equal(changedType?.sourceMimetype, undefined, "a new textual representation cannot retain the old binary source metadata");
        assert.deepEqual((await find("skill://*/references/**", regex("beta"))).map(({ path }) => path), [
            "skill://beta/references/guide.md", "skill://beta/references/nested/rules.md",
        ]);
        const target = parsePath("skill://alpha/references/guide.md");
        assert.match(String((await dispatch(readStmt(target))).content), /alpha current guidance/);
        await writeFile(join(root, ".agents", "skills", "alpha", "references", "guide.md"), "Changed on disk.\n");
        assert.match(String((await dispatch(readStmt(target))).content), /Changed on disk/);
        for (const op of ["### EDIT0 (skill://alpha/references/guide.md) <1,-1>\nchanged", "### KILL0 (skill://alpha/references/guide.md)"]) {
            const parsed = PlurnkParser.parse(`## PLAN0\n[]\n${op}`);
            const item = parsed.items.find((item) => item.kind === "statement" && item.statement.op !== "PLAN");
            assert.ok(item?.kind === "statement");
            const result = await dispatch(item.statement);
            assert.equal(result.status, 403, JSON.stringify(result));
        }
        await rm(join(root, ".agents", "skills", "alpha", "references", "nested", "rules.md"));
        assert.deepEqual((await find("skill://alpha/references/*")).map(({ path }) => path), ["skill://alpha/references/guide.md"]);
        const context = { scope: "worker" as const, workspaceId, workerId: model };
        await daemon.invokeModuleAction("worker.skills.disable", { alias: "alpha" }, context);
        assert.equal((await dispatch(readStmt(target))).status, 404, "disabled resources cannot be read from cached entries");
        assert.deepEqual((await find("skill://*/SKILL.md")).map(({ path }) => path), ["skill://beta/SKILL.md"]);
        await daemon.invokeModuleAction("worker.skills.enable", { alias: "alpha" }, context);
        assert.match(String((await dispatch(readStmt(target))).content), /Changed on disk/);
    });
});

for (const proposals of ["accept", "reject"] as const) {
    test(`{§skills-resources} native skill execution preserves siblings and cwd, behind ${proposals} proposal policy`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-skill-exec-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const directory = join(root, ".agents", "skills", "sample");
        await mkdir(join(directory, "scripts"), { recursive: true });
        await mkdir(join(directory, "assets"));
        await writeFile(join(directory, "SKILL.md"), "---\nname: sample\ndescription: Run the sample script\n---\nRun scripts/main.mjs.\n");
        await writeFile(join(directory, "scripts", "sibling.mjs"), 'export default "IMPORTED_SIBLING";\n');
        await writeFile(join(directory, "assets", "input.txt"), "RELATIVE_ASSET");
        const script = join(directory, "scripts", "main.mjs");
        const marker = join(root, "ran.json");
        await writeFile(script, [
            'import { readFile, writeFile } from "node:fs/promises";',
            'import sibling from "./sibling.mjs";',
            'const asset = await readFile(new URL("../assets/input.txt", import.meta.url), "utf8");',
            'await writeFile("ran.json", JSON.stringify({ file: import.meta.filename, cwd: process.cwd(), sibling, asset }));',
            'console.log("NATIVE_EXEC_COMPLETE");',
        ].join("\n"));
        const provider = new CapturingMock({ contextWindow: 32768, responses: [
            turn("### READ0 (skill://sample/scripts/main.mjs) <1,-1>"),
            turn("### EXEC0 [node] (skill://sample/scripts/main.mjs)"),
            turn("", true),
        ] });
        await withDaemon(provider, async (_db, _daemon, addr) => {
            const ws = await connect(addr);
            t.after(() => ws.close());
            await rpcCall(ws, 1, "workspace.create", { name: `native-skill-${crypto.randomUUID()}`, projectRoot: root });
            const result = await runLoopToTerminal(ws, 2, { prompt: "Execute the installed skill script.", policy: { proposals } });
            assert.equal(result.finalStatus, 200);
            if (proposals === "accept") {
                assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), {
                    file: script, cwd: root, sibling: "IMPORTED_SIBLING", asset: "RELATIVE_ASSET",
                });
                assert.match(provider.packets.at(-1)!, /NATIVE_EXEC_COMPLETE/);
            } else {
                await assert.rejects(stat(marker), { code: "ENOENT" });
                assert.match(provider.packets.at(-1)!, /reject/i, "the model sees the proposal refusal");
            }
            assert.match(await readFile(script, "utf8"), /IMPORTED_SIBLING|sibling/, "the native script is not removed as a temporary");
        });
    });
}

test("{§skills-resources} {§packet-attachment-parts} a sliced skill asset READ delivers its complete native image once", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-image-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, ".agents", "skills", "sample");
    await mkdir(join(dir, "assets"), { recursive: true });
    await writeFile(join(dir, "SKILL.md"), "---\nname: sample\ndescription: Inspect an image\n---\nSee assets/image.png.\n");
    await writeFile(join(dir, "assets", "image.png"), PNG);
    const provider = new CapturingMock({ contextWindow: 32768, inputModalities: ["image"], responses: [
        turn("### READ0 (skill://sample/assets/image.png#bytes) <1,3>"),
        turn(""),
        turn("", true),
    ] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: `skill-image-${crypto.randomUUID()}`, projectRoot: root });
        const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect the image.", policy: { proposals: "accept" } });
        assert.equal(result.finalStatus, 200);
    });
    const user = provider.received[1]?.find((message) => message.role === "user");
    assert.ok(Array.isArray(user?.content), "the skill asset reaches the native request");
    const image = user.content.find((part) => part.type === "file");
    assert.ok(image?.type === "file");
    assert.equal(image.mediaType, "image/png");
    assert.deepEqual(Buffer.from(image.data), PNG);
    assert.match(chatMessageText(user), /1:89\n2:50\n3:4e/);
    const later = provider.received[2]?.find((message) => message.role === "user");
    assert.equal(typeof later?.content, "string", "the next request keeps the receipt, not a permanent image");
});

test("{§skills-functionality} a model discovers a skill and reads its original tree through the skill authority", async (t) => {
    const previous = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        else process.env.PLURNK_SERVICE_FILES_ITEMS = previous;
    });
    const root = await mkdtemp(join(tmpdir(), "plurnk-skill-resources-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, ".agents", "skills", "sample");
    await mkdir(join(dir, "references", "nested"), { recursive: true });
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "SKILL.md"), "---\nname: sample\ndescription: Inspect the sample fixture\nlicense: MIT\n---\nRead [the guide](references/guide.md).\n");
    await writeFile(join(dir, "references", "guide.md"), "REFERENCE_SENTINEL\nSee nested/rules.md.\n");
    await writeFile(join(dir, "references", "nested", "rules.md"), "NESTED_SENTINEL\n");
    await writeFile(join(dir, "assets", "sample.bin"), Buffer.from([0x00, 0xff, 0x81]));
    const provider = new CapturingMock({ contextWindow: 32768, responses: [
        turn("### READ0 (skill://sample/SKILL.md) <1,-1>"),
        turn("### FIND0 (skill://sample/references/**) <1,-1>\n### READ0 (skill://sample/references/guide.md) <1,-1>\n### READ0 (skill://sample/references/nested/rules.md) <1,-1>\n### READ0 (skill://sample/assets/sample.bin) <1,-1>"),
        turn("", true),
    ] });
    await withDaemon(provider, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        t.after(() => ws.close());
        await rpcCall(ws, 1, "workspace.create", { name: `skill-resources-${crypto.randomUUID()}`, projectRoot: root });
        const result = await runLoopToTerminal(ws, 2, { prompt: "Inspect the installed sample skill.", policy: { proposals: "accept" } });
        assert.equal(result.finalStatus, 200);
        assert.match(provider.packets[0]!, /skill:\/\/sample\/SKILL\.md/, "initial discovery addresses the source skill");
        assert.match(provider.packets[0]!, /Inspect the sample fixture/, "initial discovery carries the standard description");
        assert.doesNotMatch(provider.packets[0]!, /REFERENCE_SENTINEL|NESTED_SENTINEL/, "supporting bodies are not injected by discovery");
        assert.match(provider.packets[1]!, /license: MIT/, "READ preserves optional frontmatter, not a rewritten synopsis");
        assert.match(provider.packets[1]!, /references\/guide\.md/, "source-relative links survive unchanged");
        assert.match(provider.packets[2]!, /REFERENCE_SENTINEL/);
        assert.match(provider.packets[2]!, /NESTED_SENTINEL/);
        const binaryReceipt = provider.packets[2]!.split("\n\n### log://").find((section) => section.includes('"target":"skill://sample/assets/sample.bin"'));
        assert.ok(binaryReceipt, "binary READ has a receipt");
        assert.match(binaryReceipt, /\n1:00\n2:ff\n3:81/, "binary assets use the ordinary byte projection");
    });
});
