// Contract: {§mimetype-projection-identity}. Issue #175 is provenance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import BaseHandler from "./BaseHandler.ts";
import { discover } from "./discover.ts";
import Mimetypes from "./Mimetypes.ts";
import MimetypePluginError from "./MimetypePluginError.ts";
import type { Discovery, HandlerInfo, HandlerMetadata, Registry } from "./types.ts";

let configuration = "configuration-a";

class ConfigurableHandler extends BaseHandler {
    override projectionConfiguration(): string {
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

type HandlerConstructor = new (metadata: HandlerMetadata) => BaseHandler;

const mimetypes = (
    handlerInfo: HandlerInfo,
    Handler: HandlerConstructor = ConfigurableHandler,
): Mimetypes => {
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
        loader: async () => ({ default: Handler }),
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

    it("fails a non-string handler configuration at the plugin boundary", async () => {
        class InvalidConfigurationHandler extends BaseHandler {
            override projectionConfiguration(): never {
                return 42 as never;
            }
        }
        const service = mimetypes(
            info("@community/invalid", "reader-1"),
            InvalidConfigurationHandler,
        );

        await assert.rejects(
            () => service.projectionIdentity("text/x-community"),
            (error: unknown) => {
                assert.ok(error instanceof MimetypePluginError);
                assert.match(error.message, /projectionConfiguration\(\) must return a string/u);
                assert.ok(error.cause instanceof TypeError);
                return true;
            },
        );
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

    it("includes the installed Tree-sitter grammar artifact", async () => {
        const service = new Mimetypes({
            discovery: await discover({ packageDirs: [] }),
        });

        const first = await service.projectionIdentity("text/x-python");
        assert.match(first, /^[a-f0-9]{64}$/u);
        assert.equal(await service.projectionIdentity("text/x-python"), first);
    });
});
