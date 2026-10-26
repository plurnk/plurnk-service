import test from "node:test";
import assert from "node:assert/strict";
import SchemeCtxImpl from "./SchemeCtxImpl.ts";
import type { Db } from "../Db.ts";
import type { PlurnkSchemeContext, SchemeManifest } from "../scheme-types.ts";
import LiveSubscriptions from "../LiveSubscriptions.ts";

const manifest: SchemeManifest = {
    name: "example",
    channels: { body: "text/markdown" },
    defaultChannel: "body",
    category: "data",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
};

test("{§scheme-surface} {§capability-ctx} SchemeCtxImpl exposes only the public extension context", () => {
    const internal: PlurnkSchemeContext = {
        db: {} as Db,
        workspaceId: 1,
        sessionId: 2,
        loopId: 3,
        turnId: 4,
        writer: "model",
        signal: undefined,
        injectSession: async () => ({ action: "enqueued_new_loop", loopId: 1, message: "message://child/1" }),
        weigh: () => 0,
    };

    const ctx = new SchemeCtxImpl(internal, manifest.name, manifest, new LiveSubscriptions(), {  });

    assert.deepEqual(Object.keys(ctx).toSorted(), [
        "channels",
        "entries",
        "interactions",
        "logEntryId",
        "loopId",
        "messages",
        "notify",
        "projection",
        "resources",
        "sessionId",
        "signal",
        "subscriptions",
        "turnId",
        "workspaceId",
        "writer",
    ]);
    assert.equal("db" in ctx, false);
    assert.equal("mimetypes" in ctx, false);
    assert.equal("executors" in ctx, false);
    assert.equal("injectSession" in ctx, false);
    assert.equal("pushNotice" in ctx, false);
});
