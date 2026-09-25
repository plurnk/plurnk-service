import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import { packetSection } from "./_helpers.ts";
import { connect, makeMockResponse, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

const OPTIONAL = ["perl", "ruby", "lua", "deno", "bun", "tcl", "bc", "awk", "jq", "sqlite"];

for (const enabled of [false, true]) {
    test(`{§executor-default-inventory}: optional executors are ${enabled ? "explicit opt-ins" : "absent from the default model survey"}`, async (t) => {
        const previousFilesItems = process.env.PLURNK_SERVICE_FILES_ITEMS;
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        t.after(() => {
            if (previousFilesItems === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS;
            else process.env.PLURNK_SERVICE_FILES_ITEMS = previousFilesItems;
        });
        if (enabled) {
            for (const tag of OPTIONAL) {
                const key = `PLURNK_EXECS_${tag.toUpperCase()}`;
                const previous = process.env[key];
                process.env[key] = "1";
                t.after(() => {
                    if (previous === undefined) delete process.env[key];
                    else process.env[key] = previous;
                });
            }
        }
        const registry = await ExecutorRegistry.build();
        for (const tag of OPTIONAL) {
            assert.equal(registry.entry(tag) !== undefined, enabled, `${tag} registration follows the package floor and operator override`);
        }
        for (const tag of ["sh", "node", "python3"]) {
            assert.ok(registry.entry(tag), `${tag} remains in the default composition`);
        }

        const mock = new Mock({ contextWindow: 100000, responses: [makeMockResponse("````KILL\nReady.\n````")] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: `executor-defaults-${enabled}` });
                const { finalStatus, turnIds } = await runLoopToTerminal(ws, 2, {
                    prompt: "Confirm readiness.", policy: { proposals: "accept" },
                });
                assert.equal(finalStatus, 200);
                const row = await db.test_get_packet.get<{ packet: string }>({ id: turnIds![1] });
                assert.ok(row, "the first model turn retains its actual input packet");
                const survey = packetSection(JSON.parse(row.packet), "log");
                for (const tag of [...OPTIONAL, "sh", "node", "python3"]) {
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
