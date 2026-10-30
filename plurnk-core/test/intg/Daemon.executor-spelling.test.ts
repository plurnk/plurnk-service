import assert from "node:assert/strict";
import test from "node:test";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { readStmt, urlPath } from "./_dsl.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { namedModelSession } from "./_sessions.ts";

for (const alias of ["ts", "javascript", "typescript", "node"] as const) {
    test(`{§fence-pairing}: the daemon routes ${alias} through js`, async (t) => {
        serverProposals(t, "accept");
        const directory = await mkdtemp(join(tmpdir(), `plurnk-js-spelling-${alias}-`));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const witness = join(directory, "executed.txt");
        const source = [
            `\`\`\`${alias}`,
            'const fs = await import("node:fs/promises");',
            'const label: string = "executed";',
            `await fs.writeFile(${JSON.stringify(witness)}, label);`,
            'console.log("js-runtime-witness");',
            "```",
            "",
            "```WAIT",
            "Observe the result.",
            "```",
        ].join("\n");
        const mock = new Mock({ contextWindow: 100_000, responses: [
            makeRawMockResponse(source, 10),
            makeRawMockResponse("```SEND [200]\nResult observed.\n```", 10),
        ] });
        await withDaemon(mock, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: `js-spelling-${alias}` });
                const [workspace] = await daemon.listWorkspaces();
                const sessionId = await namedModelSession(daemon, workspace.id, "main");
                const reference = async (runtime: string) => (await daemon.dispatchClientAction({ workspaceId: workspace.id, actor: TEST_OWNER,
                    statements: [readStmt(urlPath("plurnk", `/${runtime}.md`))] }))[0];
                assert.equal((await reference("js")).status, 200, "js remains discoverable");
                assert.equal((await reference(alias)).status, 404, "the accepted spelling adds no reference document");
                const { finalStatus, turnIds } = await runLoopToTerminal(client, 2, {
                    prompt: "Run the snippet and observe the result.", sessionId,
                });
                assert.equal(finalStatus, 200);
                assert.equal(turnIds?.length, 3);
                const sources = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: sessionId });
                assert.equal(sources.find((row) => row.turn_id === turnIds[1] && row.kind === "ops")?.content, source,
                    "forensic source retains the authored spelling");
                const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turnIds[1] });
                const invocation = rows.find((row) => row.op === "js");
                assert.ok(invocation, "the authored alias fence becomes a canonical js receipt");
                assert.equal(rows.some((row) => row.op === alias), false);
                const packetRow = await db.test_get_packet.get<{ packet: string }>({ id: turnIds[2] });
                const packet = JSON.parse(packetRow!.packet);
                assert.equal(await readFile(witness, "utf8"), "executed");
                const execution = logEntries(packet).find((entry) => (entry.stream ?? "").startsWith("js:///"));
                assert.ok(execution, "execution publishes through js's output scheme");
                const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string; state: string }>({
                    pathname: new URL(String(execution.stream)).pathname, scheme: "js", name: "stdout",
                });
                assert.equal(channel?.content, "js-runtime-witness\n", "the js process actually ran the body");
                assert.match(packetSection(packet, "log"), /js-runtime-witness/,
                    "the actual js process output reaches the following packet");
            } finally { client.close(); }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Executor Inventory ({§executor-policy})
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TAGS = ["sh", "js", "python3"];

for (const disablePython of [false, true]) {
    test(`{§executor-policy}: default executors are sh, js, and python3 (${disablePython ? "with PLURNK_EXECS_PYTHON3=0" : "default"})`, async (t) => {
        serverProposals(t, "accept");
        const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        t.after(() => {
            if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
            else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
        });
        if (disablePython) {
            const key = "PLURNK_EXECS_PYTHON3";
            const previous = process.env[key];
            process.env[key] = "0";
            t.after(() => {
                if (previous === undefined) delete process.env[key];
                else process.env[key] = previous;
            });
        }
        const registry = await ExecutorRegistry.build();
        assert.equal(registry.entry("python3") !== undefined, !disablePython, "python3 registration follows PLURNK_EXECS_PYTHON3");
        for (const tag of ["sh", "js"]) {
            assert.ok(registry.entry(tag), `${tag} remains in the default composition`);
        }

        const mock = new Mock({ contextWindow: 100000, responses: [makeMockResponse("````SEND [200]\nReady.\n````")] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `executor-defaults-${disablePython}` });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, {
                    prompt: "Confirm readiness.",
                });
                assert.equal(finalStatus, 200);
                const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds![1] });
                assert.ok(row, "the first model turn retains its actual input packet");
                const survey = packetSection(JSON.parse(row.packet), "log");
                for (const tag of DEFAULT_TAGS) {
                    assert.equal(
                        survey.includes(`plurnk:///${tag}.md`),
                        registry.availableRuntimes().includes(tag),
                        `${tag} teaching is present exactly when the executor is admitted and available`,
                    );
                }
            } finally {
                ws.close();
            }
        });
    });
}
