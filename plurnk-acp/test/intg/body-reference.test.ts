// {§acp-body-reference} — a deep conversation whose bodies are large reaches the official client lean: every message
// travels and no body does, nor the line anchors only the model edits by, the helper's as much as the worker's; each
// body is one fetch at its URL, exactly as the row holds it, typed as its receipt types it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HttpAgent } from "../../src/client.ts";
import type { DocumentPart, Message } from "../../src/types.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { bindListener, openTestDatabase, SERVICE } from "./_helpers.ts";

const execFileP = promisify(execFile);

test("{§acp-body-reference}: a deep conversation with large bodies reaches the official client lean, each body one fetch away", { timeout: 120_000 }, async (t) => {
    await import(join(SERVICE, "test/setup.ts"));
    const [{ default: Daemon }, { makeMockResponse }, { waitForDb }, { hermeticGitEnv }] = await Promise.all([
        import(join(SERVICE, "src/server/Daemon.ts")), import(join(SERVICE, "test/intg/_mock.ts")),
        import(join(SERVICE, "test/intg/_rpc.ts")), import(join(SERVICE, "src/core/git-env.ts")),
    ]);
    // A project whose one tracked file is a megabyte of text.
    const root = await mkdtemp(join(tmpdir(), "plurnk-body-reference-"));
    const big = Array.from({ length: 20_000 }, (_, line) => `line ${String(line).padStart(5, "0")} of the large document under review\n`).join("");
    await writeFile(join(root, "big.md"), big);
    const git = (...args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git("init", "-q");
    await git("add", "big.md");
    await git("-c", "user.email=fixture@plurnk.invalid", "-c", "user.name=fixture", "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed");
    // The worker delegates; its helper reads the file and concludes; the worker then reads it too and answers.
    const provider = new Mock({ contextWindow: 4_000_000, responses: [
        makeMockResponse("````WORK (worker://helper)\nRead big.md, then say done.\n````\n````WAIT\nWaiting on the helper.\n````"),
        makeMockResponse("````READ (big.md) <1,-1>\n````"),
        makeMockResponse("````SEND [200]\nDone.\n````"),
        makeMockResponse("````READ (big.md) <1,-1>\n````"),
        makeMockResponse("````SEND [200]\nBoth read.\n````"),
    ] });
    const db = await openTestDatabase();
    const http = await bindListener();
    const daemon = new Daemon({ db, http, provider, nodeModulesPath: join(SERVICE, "node_modules") });
    const agents: HttpAgent[] = [];
    t.after(async () => {
        for (const agent of agents) agent.abortRun();
        await daemon.stop();
        await http.close();
        await db.close();
        await rm(root, { recursive: true, force: true });
    });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "bodies", projectRoot: root });
    const { host, port } = http.httpAddress();
    const url = `http://${host}:${port}/acp`;
    const answered = new Set<number>();
    const off = daemon.subscribeToEvents((_workspaceId: number | null, method: string, params: unknown) => {
        if (method === "loop/terminated") answered.add((params as { workerId: number }).workerId);
    });
    t.after(off);

    const submitter = new HttpAgent({ url, threadId: "main" });
    agents.push(submitter);
    submitter.messages = [{ id: "prompt-1", role: "user", content: "Have the helper read big.md, then read it yourself." }];
    await submitter.runAgent({ forwardedProps: { plurnk: { workspace: "bodies", control: true } } });
    const main = await daemon.readWorker({ workspaceId, identity: { name: "main" } });
    assert.ok(main);
    await waitForDb(async () => answered.has(main.id) ? (await daemon.listWorkerLoops({ workspaceId, workerId: main.id })) : [],
        (loops: ReadonlyArray<{ status: number }>) => loops.some(({ status }) => status === 200), { timeoutMs: 60_000 });

    const reader = new HttpAgent({ url, threadId: "main" });
    agents.push(reader);
    let snapshot = 0;
    await reader.runAgent({ forwardedProps: { plurnk: { workspace: "bodies", descendants: true } } }, {
        onMessagesSnapshotEvent: ({ event }) => { snapshot = JSON.stringify(event).length; },
    });
    assert.ok(snapshot > 0 && snapshot < 100_000, `the snapshot holds no body: ${snapshot} characters beside two reads of ${big.length}`);
    const results = reader.messages.filter((message): message is Extract<Message, { role: "tool" }> => message.role === "tool");
    assert.ok(!results.some((message) => JSON.stringify(message.content).includes("of the large document")), "no body text rides any message");
    const documents = results.flatMap((message) => Array.isArray(message.content)
        ? message.content.filter((part): part is DocumentPart => part.type === "document").map((part) => ({ message, part }))
        : []);
    assert.ok(documents.some(({ message }) => message.subagentRunId !== undefined), "the helper's read rides its subagent run, lean like the worker's");
    let large = 0;
    for (const { part } of documents) {
        assert.equal(part.source.type, "url");
        // {§acp-entry-route} The HTTP form of the row's log address, read from its worker's perspective.
        const reference = new URL(part.source.type === "url" ? part.source.value : "");
        const perspective = /^\/acp\/(\d+)\/(\d+)\/entry$/u.exec(reference.pathname);
        const address = /^log:\/\/\/(\d+)\/(\d+)\/(\d+)\/READ$/u.exec(reference.searchParams.get("target") ?? "");
        assert.ok(perspective && address, `the body's address is its row's log address at this daemon: ${JSON.stringify(part.source)}`);
        const [space, worker] = perspective.slice(1).map(Number);
        const [loopSeq, turnSeq, sequence] = address.slice(1).map(Number);
        assert.equal(space, workspaceId);
        const row = (await daemon.readLog({ workspaceId, workerId: worker, loopSeq, turnSeq, sequence }))
            .find(({ op }: { op: string | null }) => op === "READ");
        const receipt = (typeof row?.rx === "string" ? JSON.parse(row.rx) : row?.rx) as { content: string; mimetype: string };
        if (receipt.content.length > 500_000) large += 1;
        const fetched = await fetch(part.source.type === "url" ? part.source.value : "");
        assert.equal(fetched.status, 200);
        assert.equal(fetched.headers.get("content-type"), `${receipt.mimetype}; charset=utf-8`, "typed as its receipt types it");
        assert.equal(part.source.type === "url" ? part.source.mimeType : undefined, receipt.mimetype, "the part names the body's type");
        assert.equal(await fetched.text(), receipt.content, "the body, exactly as the row holds it");
    }
    assert.equal(large, 2, "both large reads, the helper's and the worker's, carry their bodies by reference");
});
