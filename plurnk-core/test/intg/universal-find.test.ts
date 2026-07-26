import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-grammar";
import type {
    FindStatement,
    SchemeCtx,
    SchemeHandler,
    SchemeManifest,
    SchemeResult,
} from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertTurn,
    insertWorker,
    insertWorkspace,
    openMigrated,
} from "./_helpers.ts";

class PreparedDataScheme implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "prepared",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        scope: "workspace",
        writableBy: ["model"],
        volatile: false,
        modelVisible: true,
    };

    async prepareFind(_statement: FindStatement, ctx: SchemeCtx): Promise<SchemeResult> {
        return ctx.entries.write("/fact.md", {
            channels: {
                body: {
                    content: "the universal answer is forty-two",
                    mimetype: "text/markdown",
                },
            },
            tags: [],
        });
    }
}

const parseFind = (dsl: string): FindStatement => {
    const item = PlurnkParser.parse(`<<PLAN::PLAN\n${dsl}`).items.find(
        (candidate) => candidate.kind === "statement" && candidate.statement.op === "FIND",
    );
    if (item?.kind !== "statement" || item.statement.op !== "FIND") {
        throw new Error(`no FIND parsed from ${dsl}`);
    }
    return item.statement;
};

test("data schemes inherit standard FIND after their optional preparation hook", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("prepared", new PreparedDataScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("<<FIND(prepared:///fact.md):*forty-two*:FIND"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 200);
        assert.match(String(result.content), /prepared:\/\/\/fact\.md/);
        assert.match(String(result.content), /"matchSpan"/);
    } finally {
        await db.close();
    }
});

test("non-data schemes without FIND remain honestly unsupported", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    class ControlScheme {
        static manifest: SchemeManifest = {
            name: "control-only",
            channels: {},
            defaultChannel: "body",
            category: "control",
            scope: "workspace",
            writableBy: ["model"],
            volatile: false,
            modelVisible: true,
        };
    }
    schemes.register("control-only", new ControlScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    try {
        const workspaceId = await insertWorkspace(db, `universal-find-control-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const result = await engine.dispatch({
            statement: parseFind("<<FIND(control-only:///**)::FIND"),
            workspaceId,
            workerId,
            loopId,
            turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 501);
    } finally {
        await db.close();
    }
});
