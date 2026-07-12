import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Mimetypes from "../../src/Mimetypes.ts";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "text-plain");
const handlerPath = path.join(fixtureDir, "src", "index.ts");

describe("full pipeline — text/plain fixture (no structural signal)", () => {
    let tmp: string;

    before(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-intg-"));
    });

    after(async () => {
        await fs.rm(tmp, { recursive: true, force: true });
    });

    function buildMimetypes(): Mimetypes {
        return new Mimetypes({
            discoverOptions: { packageDirs: [fixtureDir] },
            loader: async (_packageName) => import(handlerPath),
        });
    }

    it("discovers the fixture's plurnk metadata", async () => {
        const m = buildMimetypes();
        await m.ready();
        const mimetype = await m.detect({ path: "anything.txt" });
        assert.equal(mimetype, "text/plain");
    });

    it("instantiates the handler with discovered metadata", async () => {
        const m = buildMimetypes();
        const handler = await m.getHandler("text/plain");
        assert.ok(handler !== null);
        assert.equal(handler.mimetype, "text/plain");
        assert.equal(handler.glyph, "📄");
        assert.deepEqual([...handler.extensions], [".txt"]);
    });

    it("processes inline content end-to-end: metadata + empty structural channels", async () => {
        const m = buildMimetypes();
        const result = await m.process({
            path: "greeting.txt",
            content: "hello world\nsecond line",
        });
        assert.equal(result.ok, true);
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.totalLines, 2);
        assert.equal(result.extent, 2);
        // text/plain has no structural extraction path — empty by design.
        assert.deepEqual(result.symbols, []);
        assert.equal(result.deepJson, null);
        assert.equal(result.deepXml, "");
        assert.deepEqual(result.references, []);
    });

    it("processes content read from disk", async () => {
        const filePath = path.join(tmp, "from-disk.txt");
        await fs.writeFile(filePath, "disk content");

        const m = buildMimetypes();
        const result = await m.process({ path: filePath });
        assert.equal(result.ok, true);
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.totalLines, 1);
    });

    it("channels: [] returns metadata only", async () => {
        const m = buildMimetypes();
        const result = await m.process(
            { path: "long.txt", content: "any content at all" },
            { channels: [] },
        );
        assert.deepEqual(result, {
            mimetype: "text/plain",
            ok: true,
            totalLines: 1,
            extent: 1,
        });
    });

    it("returns ok:false when the file doesn't exist", async () => {
        const m = buildMimetypes();
        const result = await m.process({ path: "/nonexistent/path/foo.txt" });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.ok, false);
        assert.equal("symbols" in result, false);
    });

    it("returns ok:false with null mimetype for unknown extension", async () => {
        const m = buildMimetypes();
        const result = await m.process({
            path: "foo.unknown-extension",
            content: "x",
        });
        assert.equal(result.mimetype, null);
        assert.equal(result.ok, false);
    });

    it("caches the handler across multiple process() calls", async () => {
        let loadCount = 0;
        const m = new Mimetypes({
            discoverOptions: { packageDirs: [fixtureDir] },
            loader: async (_pkg) => {
                loadCount += 1;
                return import(handlerPath);
            },
        });
        await m.process({ path: "a.txt", content: "a" });
        await m.process({ path: "b.txt", content: "b" });
        await m.process({ path: "c.txt", content: "c" });
        assert.equal(loadCount, 1, "loader should be called exactly once");
    });
});
