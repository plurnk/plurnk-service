import test from "node:test";
import assert from "node:assert/strict";
import type {
    EntryEditResult,
    EntryReadResult,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import type { EditStatement, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import { Validator, type ClientEntry, type EntryReadResult as EntryReadWire } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { rulerCount } from "../../src/core/token-ruler.ts";
import { openMigrated } from "./_helpers.ts";
import Dsl from "./dsl.ts";

class PrivateNotes implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "private-notes",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["client"],
        volatile: false,
        modelVisible: true,
    };

    async resolveEntryAddress(target: ParsedPath): Promise<{ pathname: string; owner: "worker" } | null> {
        return target.kind === "url"
            ? { pathname: target.pathname, owner: "worker" }
            : null;
    }

    async editBatch(statements: readonly EditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.editBatch(statements, "worker");
    }

    async read(statement: ReadStatement, ctx: SchemeCtx): Promise<EntryReadResult> {
        return ctx.entries.operations.read(statement, "worker");
    }
}

const body = (result: EntryReadWire): ClientEntry => {
    const exact = Validator.assertEntryReadResult(result);
    assert.equal(exact.status, 200);
    assert.ok(exact.entry !== null);
    return exact.entry;
};

test("entry.read resolves one owner-aware client entry and returns the exact shared wire", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("private-notes", new PrivateNotes());
    const daemon = new Daemon({ db, schemes, provider: null });
    await daemon.start();
    try {
        const workspace = await daemon.createWorkspace({ name: `entry-wire-${crypto.randomUUID()}` });
        const parent = await daemon.createConversationWorker({ workspaceId: workspace.workspaceId, name: "entry-parent" });
        const child = await daemon.forkWorker({ workspaceId: workspace.workspaceId, workerId: parent.workerId, name: "entry-child" });

        for (const [workerId, content] of [
            [parent.workerId, "A😀éZ"],
            [child.workerId, "child"],
        ] as const) {
            const written = await daemon.dispatchAsClient({
                workspaceId: workspace.workspaceId,
                workerId,
                statement: Dsl.buildEdit({
                    target: "private-notes:///same",
                    content,
                    tags: [workerId === parent.workerId ? "parent" : "child"],
                }),
            });
            assert.equal(written.status, 201);
        }

        const parentRead = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: parent.workerId,
            target: "private-notes:///same",
        }));
        assert.deepEqual(parentRead, {
            entryId: parentRead.entryId,
            target: "private-notes:///same",
            channels: {
                body: {
                    content: "A😀éZ",
                    contentOffset: 0,
                    contentLength: 4,
                    mimetype: "text/markdown",
                    tokens: rulerCount("A😀éZ"),
                    state: "static",
                },
            },
            tags: ["parent"],
        });

        const childRead = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: child.workerId,
            target: "private-notes:///same",
        }));
        assert.equal(childRead.channels.body?.content, "child");
        assert.notEqual(childRead.entryId, parentRead.entryId);

        const slice = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: parent.workerId,
            target: "private-notes:///same",
            channel: "body",
            offset: 2,
        }));
        assert.deepEqual(slice.channels.body, {
            content: "éZ",
            contentOffset: 2,
            contentLength: 4,
            mimetype: "text/markdown",
            tokens: rulerCount("A😀éZ"),
            state: "static",
        });

        const caughtUp = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: parent.workerId,
            target: "private-notes:///same#ignored",
            channel: "body",
            offset: 100,
        }));
        assert.equal(caughtUp.channels.body?.content, "");
        assert.equal(caughtUp.channels.body?.contentOffset, 4);
        assert.equal(caughtUp.target, "private-notes:///same");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("entry.read applies worker authority ancestry without leaking an unauthorized owner", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        const workspace = await daemon.createWorkspace({ name: `entry-owner-${crypto.randomUUID()}` });
        const parent = await daemon.createConversationWorker({ workspaceId: workspace.workspaceId, name: "owner-parent" });
        const child = await daemon.forkWorker({ workspaceId: workspace.workspaceId, workerId: parent.workerId, name: "owner-child" });
        for (const [workerId, content] of [
            [parent.workerId, "parent"],
            [child.workerId, "child"],
        ] as const) {
            assert.equal((await daemon.dispatchAsClient({
                workspaceId: workspace.workspaceId,
                workerId,
                statement: Dsl.buildEdit({ target: "worker://~/same", content }),
            })).status, 201);
        }

        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: parent.workerId,
            target: "worker://~/same",
        })).channels.body?.content, "parent");
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: child.workerId,
            target: "worker://~/same",
        })).channels.body?.content, "child");
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: parent.workerId,
            target: "worker://owner-child/same",
        })).channels.body?.content, "child");

        const denied = Validator.assertEntryReadResult(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            workerId: child.workerId,
            target: "worker://owner-parent/same",
        }));
        assert.equal(denied.status, 404);
        assert.equal(denied.entry, null);
        assert.doesNotMatch(JSON.stringify(denied), /"ownerId"|"content"/);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
