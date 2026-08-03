// Contracts: {§mimetype-discovery}, {§mimetype-handler-contract}.
// Issue #88 is provenance.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import Mimetypes from "../Mimetypes.ts";
import MimetypePluginError from "../MimetypePluginError.ts";
import type { Discovery, HandlerInfo } from "../types.ts";

const roots: string[] = [];
const info: HandlerInfo = {
    mimetype: "text/fixture",
    glyph: "F",
    packageName: "@fixture/mimetype-handler",
    extensions: [".fixture"],
    binary: false,
    source: "package",
};

const discovery: Discovery = {
    registry: {
        byExtension: new Map([[".fixture", info.mimetype]]),
        byFilename: new Map(),
    },
    handlers: new Map([[info.mimetype, info]]),
    skipped: [],
};

const orchestrator = (loader: () => Promise<unknown>): Mimetypes => new Mimetypes({
    discovery,
    loader,
});

function isPluginError(error: unknown, cause?: unknown): boolean {
    assert.ok(error instanceof MimetypePluginError);
    assert.match(error.message, /@fixture\/mimetype-handler/);
    assert.match(error.message, /text\/fixture/);
    if (cause !== undefined) assert.strictEqual(error.cause, cause);
    return true;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("declared mimetype plugin failures", () => {
    it("surfaces one declaration failure through ready, process, and query", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "plurnk-invalid-mimetype-"));
        roots.push(root);
        const packageRoot = path.join(root, "invalid-handler");
        await mkdir(packageRoot);
        await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
            name: "@fixture/invalid-handler",
            plurnk: { kind: "mimetype", handlers: "not-an-array" },
        }));

        const make = (): Mimetypes => new Mimetypes({
            discoverOptions: { packageDirs: [packageRoot], includeTreeSitter: false },
        });
        const calls = [
            () => make().ready(),
            () => make().process({ content: "fixture", hint: "text/fixture" }),
            () => make().query({ content: "fixture", hint: "text/fixture" }, "/fixture/"),
        ];

        for (const call of calls) {
            await assert.rejects(call, (error: unknown) => {
                assert.ok(error instanceof MimetypePluginError);
                assert.match(error.message, /@fixture\/invalid-handler/);
                assert.match(error.message, /handlers/);
                assert.equal(error.packageName, "@fixture/invalid-handler");
                assert.equal(error.mimetype, null);
                assert.equal(error.manifestPath, path.join(packageRoot, "package.json"));
                return true;
            });
        }
    });

    it("preserves a handler import failure through getHandler, process, and query", async () => {
        const cause = new Error("nested import exploded");
        const calls = [
            () => orchestrator(async () => { throw cause; }).getHandler(info.mimetype),
            () => orchestrator(async () => { throw cause; }).process({ content: "fixture", hint: info.mimetype }),
            () => orchestrator(async () => { throw cause; }).query(
                { content: "fixture", hint: info.mimetype },
                "/fixture/",
            ),
        ];

        for (const call of calls) await assert.rejects(call, (error: unknown) => isPluginError(error, cause));
    });

    it("preserves a handler constructor failure", async () => {
        const cause = new RangeError("constructor rejected metadata");
        class BrokenHandler {
            constructor() {
                throw cause;
            }
        }

        await assert.rejects(
            () => orchestrator(async () => ({ default: BrokenHandler })).getHandler(info.mimetype),
            (error: unknown) => isPluginError(error, cause),
        );
    });

    it("rejects an incomplete handler at load time rather than at a selected channel", async () => {
        class PartialHandler {
            readonly mimetype = info.mimetype;
            readonly glyph = info.glyph;
            readonly extensions = info.extensions;
            extractRaw(): never[] { return []; }
        }

        await assert.rejects(
            () => orchestrator(async () => ({ default: PartialHandler })).getHandler(info.mimetype),
            (error: unknown) => {
                assert.equal(isPluginError(error), true);
                assert.ok(error instanceof Error);
                assert.match(String(error.cause), /handler surface/);
                assert.doesNotMatch(error.message, /0\.15|predates/);
                return true;
            },
        );
    });
});
