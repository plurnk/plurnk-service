import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

// {§packet-inject} — PLURNK_SERVICE_PACKET_INJECT lands after capability teaching
// in the cached system slot. The operator-side pressure valve.
test("PLURNK_SERVICE_PACKET_INJECT: operator file rides as a system section after schemes", async () => {
    const db = await openMigrated();
    const dir = await mkdtemp(join(tmpdir(), "plurnk-inject-intg-"));
    const prior = process.env.PLURNK_SERVICE_PACKET_INJECT;
    try {
        await writeFile(join(dir, "ops.md"), "## House style\nPrefer sqlite over node.");
        process.env.PLURNK_SERVICE_PACKET_INJECT = join(dir, "ops.md");

        const workspaceId = await insertWorkspace(db, `inject-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });

        const { turnId } = await engine.runTurn({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "system", content: "PLURNK_MD" }, { role: "user", content: "go" }],
        });

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        assert.match(packetSection(packet, "inject"), /Prefer sqlite over node/, "the operator file is the inject section's content");
        const sysOrder = (packet.sections as Array<{ name: string; slot: string }>).filter((s) => s.slot === "system").map((s) => s.name);
        assert.equal(sysOrder.indexOf("inject"), sysOrder.indexOf("schemes") + 1, "inject follows the resource directory");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_PACKET_INJECT; else process.env.PLURNK_SERVICE_PACKET_INJECT = prior;
        await db.close();
        await rm(dir, { recursive: true, force: true });
    }
});
