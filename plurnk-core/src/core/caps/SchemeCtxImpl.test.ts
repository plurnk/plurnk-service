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
    scope: "workspace",
    writableBy: ["model"],
    volatile: false,
    modelVisible: true,
};

test("SchemeCtxImpl exposes only the public plugin context", () => {
    const internal: PlurnkSchemeContext = {
        db: {} as Db,
        workspaceId: 1,
        workerId: 2,
        loopId: 3,
        turnId: 4,
        writer: "model",
        signal: undefined,
        injectWorker: async () => ({ action: "enqueued_new_loop", loopId: 1 }),
        tokenize: () => 0,
    };

    const ctx = new SchemeCtxImpl(internal, manifest.name, manifest, new LiveSubscriptions());

    assert.deepEqual(Object.keys(ctx).toSorted(), [
        "channels",
        "entries",
        "loopId",
        "notify",
        "projection",
        "signal",
        "subscriptions",
        "tags",
        "turnId",
        "workerId",
        "workspaceId",
        "writer",
    ]);
    assert.equal("db" in ctx, false);
    assert.equal("mimetypes" in ctx, false);
    assert.equal("executors" in ctx, false);
    assert.equal("injectWorker" in ctx, false);
    assert.equal("pushTelemetry" in ctx, false);
});
