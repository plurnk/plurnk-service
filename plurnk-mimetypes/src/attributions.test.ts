// {§plugin-attribution}

import test from "node:test";
import assert from "node:assert/strict";
import type { PluginAttributionContext } from "@plurnk/plurnk-meta";
import BaseHandler from "./BaseHandler.ts";
import Mimetypes from "./Mimetypes.ts";
import type { Discovery, HandlerInfo } from "./types.ts";

const context = (attempt: number): PluginAttributionContext => ({
    workspaceId: "workspace",
    workerId: "worker",
    primaryWorkerId: "primary",
    loop: 1,
    turn: 2,
    attempt,
});

const info: HandlerInfo = {
    mimetype: "text/x-attribution-test",
    glyph: "",
    packageName: "@acme/mimetype-attribution-test",
    projectionRevision: "1",
    extensions: [".attr"],
    binary: false,
    source: "package",
};

const discovery: Discovery = {
    registry: {
        byExtension: new Map([[".attr", info.mimetype]]),
        byFilename: new Map(),
    },
    handlers: new Map([[info.mimetype, info]]),
    packageAttributions: new Map([[info.packageName, ["static:mimetype"]]]),
    skipped: [],
};

class AttributingHandler extends BaseHandler {
    attributions({ attempt }: PluginAttributionContext): string[] {
        return attempt === 2 ? ["runtime:mimetype", "static:mimetype"] : [];
    }
}

test("Mimetypes composes static tags with hooks from already-loaded handlers only", async () => {
    const mimetypes = new Mimetypes({
        discovery,
        loader: async () => ({ default: AttributingHandler }),
    });

    assert.deepEqual(
        await mimetypes.attributions(context(1)),
        ["static:mimetype"],
        "collecting telemetry does not force the lazy handler to load",
    );

    await mimetypes.getHandler(info.mimetype);
    assert.deepEqual(
        await mimetypes.attributions(context(2)),
        ["runtime:mimetype", "static:mimetype"],
        "a loaded handler controls its attempt-time tags and the host canonicalizes the union",
    );
});
