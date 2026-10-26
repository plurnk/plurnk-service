import { serverProposals } from "./_approval.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { packetSection } from "./_packet.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

const DEFAULT_TAGS = ["sh", "js", "python3"];

for (const disablePython of [false, true]) {
    test(`{§executor-default-inventory}: default executors are sh, js, and python3 (${disablePython ? "with PLURNK_EXECS_PYTHON3=0" : "default"})`, async (t) => {
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
                        survey.includes(`/_plurnk/plurnk/${tag}.md`),
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
