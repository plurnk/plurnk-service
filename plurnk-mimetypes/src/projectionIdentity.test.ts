// Contract: {§mimetype-projection-identity}. Issue #175 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import Mimetypes from "./Mimetypes.ts";
import type { Discovery, HandlerInfo, Registry } from "./types.ts";

let configuration = "configuration-a";

class ConfigurableHandler extends BaseHandler {
    projectionConfiguration(): string {
        return configuration;
    }
}

const info = (
    packageName: string,
    projectionRevision: string,
): HandlerInfo => ({
    mimetype: "text/x-community",
    glyph: "🧩",
    packageName,
    extensions: [".community"],
    binary: false,
    source: "package",
    projectionRevision,
});

const mimetypes = (handlerInfo: HandlerInfo): Mimetypes => {
    const registry: Registry = {
        byExtension: new Map([[".community", handlerInfo.mimetype]]),
        byFilename: new Map(),
    };
    const discovery: Discovery = {
        registry,
        handlers: new Map([[handlerInfo.mimetype, handlerInfo]]),
        skipped: [],
    };
    return new Mimetypes({
        discovery,
        loader: async () => ({ default: ConfigurableHandler }),
    });
};

describe("mimetype projection identity", () => {
    it("is stable for identical behavior and changes with live configuration", async () => {
        configuration = "configuration-a";
        const service = mimetypes(info("@community/cobol", "reader-1"));

        const first = await service.projectionIdentity("text/x-community");
        assert.match(first, /^[a-f0-9]{64}$/u);
        assert.equal(await service.projectionIdentity("text/x-community"), first);

        configuration = "configuration-b";
        assert.notEqual(await service.projectionIdentity("text/x-community"), first);
    });

    it("keeps package ownership and self-declared revision in the identity", async () => {
        configuration = "configuration-a";
        const first = await mimetypes(info("@community/cobol", "reader-1"))
            .projectionIdentity("text/x-community");
        const revised = await mimetypes(info("@community/cobol", "reader-2"))
            .projectionIdentity("text/x-community");
        const independent = await mimetypes(info("@another/cobol", "reader-1"))
            .projectionIdentity("text/x-community");

        assert.notEqual(revised, first);
        assert.notEqual(independent, first);
    });

    it("identifies an unregistered projection without loading plugin code", async () => {
        let loads = 0;
        const service = new Mimetypes({
            discovery: {
                registry: { byExtension: new Map(), byFilename: new Map() },
                handlers: new Map(),
                skipped: [],
            },
            loader: async () => {
                loads++;
                return { default: ConfigurableHandler };
            },
        });

        const first = await service.projectionIdentity("text/x-unregistered");
        assert.equal(await service.projectionIdentity("text/x-unregistered"), first);
        assert.equal(loads, 0);
    });
});
