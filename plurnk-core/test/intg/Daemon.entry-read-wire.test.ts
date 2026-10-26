import test from "node:test";
import assert from "node:assert/strict";
import type {
    EntryEditResult,
    ResolvedEditStatement,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
} from "@plurnk/plurnk-schemes";
import { type ParsedPath, Validator, type ClientEntry, type EntryReadResult as EntryReadWire } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { openMigrated } from "./_db.ts";
import Dsl from "./dsl.ts";
import { TEST_OWNER } from "./_approval.ts";

class Notes implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "notes", authority: "resource",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["client"],
        volatile: false,
        modelVisible: true,
    };

    async resolveEntryAddress(target: ParsedPath): Promise<{ authority: string; pathname: string } | null> {
        return target.kind === "url"
            ? { authority: target.hostname ?? "", pathname: target.pathname }
            : null;
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.editBatch(statements);
    }
}

const body = (result: EntryReadWire): ClientEntry => {
    const exact = Validator.assertEntryReadResult(result);
    assert.equal(exact.status, 200);
    assert.ok(exact.entry !== null);
    return exact.entry;
};

test("{§client-entry-address} entry.read resolves one owner-aware client entry and returns the exact shared wire", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("notes", new Notes());
    const daemon = new Daemon({ db, schemes, provider: null });
    await daemon.start();
    try {
        const workspace = await daemon.createWorkspace({ name: `entry-wire-${crypto.randomUUID()}` });
        const parent = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "entry-parent" });
        const child = await daemon.forkSession({ workspaceId: workspace.workspaceId, sessionId: parent.sessionId, name: "entry-child" });

        // A person seeds each named space; an authority is a namespace, not a principal ({§session-authority-carving}).
        for (const [name, content] of [
            ["entry-parent", "A😀éZ"],
            ["entry-child", "child"],
        ] as const) {
            const [written] = await daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId,
                actor: TEST_OWNER,
                statements: [Dsl.buildEdit({
                    target: `notes://${name}/same`,
                    content,
                })],
            });
            assert.equal(written.status, 201);
        }

        const parentRead = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "notes://entry-parent/same",
        }));
        assert.deepEqual(parentRead, {
            entryId: parentRead.entryId,
            target: "notes://entry-parent/same",
            channels: {
                body: {
                    content: "A😀éZ",
                    contentOffset: 0,
                    contentLength: 4,
                    mimetype: "text/markdown",
                    weight: contentWeight("A😀éZ"),
                    state: "static",
                },
            },
        });

        const childRead = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "notes://entry-child/same",
        }));
        assert.equal(childRead.channels.body?.content, "child");
        assert.notEqual(childRead.entryId, parentRead.entryId);

        const slice = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "notes://entry-parent/same",
            channel: "body",
            offset: 2,
        }));
        assert.deepEqual(slice.channels.body, {
            content: "éZ",
            contentOffset: 2,
            contentLength: 4,
            mimetype: "text/markdown",
            weight: contentWeight("A😀éZ"),
            state: "static",
        });

        const caughtUp = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "notes://entry-parent/same#ignored",
            channel: "body",
            offset: 100,
        }));
        assert.equal(caughtUp.channels.body?.content, "");
        assert.equal(caughtUp.channels.body?.contentOffset, 4);
        assert.equal(caughtUp.target, "notes://entry-parent/same");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§client-entry-address} entry.read applies session authority across the workspace: a child reads its parent's named space (#394)", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        const workspace = await daemon.createWorkspace({ name: `entry-owner-${crypto.randomUUID()}` });
        const parent = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "owner-parent" });
        const child = await daemon.forkSession({ workspaceId: workspace.workspaceId, sessionId: parent.sessionId, name: "owner-child" });
        for (const [name, content] of [
            ["owner-parent", "parent"],
            ["owner-child", "child"],
        ] as const) {
            const [written] = await daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId,
                actor: TEST_OWNER,
                statements: [Dsl.buildEdit({ target: `session://${name}/same`, content })],
            });
            assert.equal(written.status, 201);
        }

        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "session://owner-parent/same",
        })).channels.body?.content, "parent");
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "session://owner-child/same",
        })).channels.body?.content, "child");
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "session://owner-child/same",
        })).channels.body?.content, "child");

        // {§session-read-scope} — any session of the workspace reads a named space: the child its parent's (#394).
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "session://owner-parent/same",
        })).channels.body?.content, "parent");
        const unknown = Validator.assertEntryReadResult(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "session://no-such-session/same",
        }));
        assert.equal(unknown.status, 404);
        assert.equal(unknown.entry, null);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
