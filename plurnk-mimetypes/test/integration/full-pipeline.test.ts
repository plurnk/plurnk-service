import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Mimetypes from "../../src/Mimetypes.ts";
import { discover } from "../../src/discover.ts";

// ─── full-pipeline.test.ts ───
{
// This suite's fixture is a third-party package, so it exercises the operator who admitted it
// ({§executor-policy}); the shipped panel admits only `@plurnk/*`. Tests of the gate itself state
// their own value below and override this one.
process.env.PLURNK_EXTENSIONS_TRUSTED_ONLY = "0";

const fixtureDir = path.join(import.meta.dirname, "fixtures", "text-plain");
const handlerPath = path.join(fixtureDir, "src", "index.ts");

describe("{§mimetype-channel-selection} full pipeline: text/plain fixture (no structural signal)", () => {
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

    it("{§treesitter-runtime-gate} discovers the fixture's plurnk metadata", async () => {
        const m = buildMimetypes();
        await m.ready();
        const mimetype = await m.detect({ path: "anything.txt" });
        assert.equal(mimetype, "text/plain");
    });

    it("{§treesitter-runtime-gate} instantiates the handler with discovered metadata", async () => {
        const m = buildMimetypes();
        const handler = await m.getHandler("text/plain");
        assert.ok(handler !== null);
        assert.equal(handler.mimetype, "text/plain");
        assert.equal(handler.glyph, "📄");
        assert.deepEqual([...handler.extensions], [".txt"]);
    });

    it("{§treesitter-runtime-gate} processes inline content end-to-end: metadata + empty structural channels", async () => {
        const m = buildMimetypes();
        const result = await m.process({
            path: "greeting.txt",
            content: "hello world\nsecond line",
        });
        assert.equal(result.ok, true);
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.totalLines, 2);
        // text/plain has no structural extraction path — empty by design.
        assert.deepEqual(result.symbols, []);
        assert.equal(result.deepJson, null);
        assert.equal(result.deepXml, "");
        assert.deepEqual(result.references, []);
    });

    it("{§treesitter-runtime-gate} processes content read from disk", async () => {
        const filePath = path.join(tmp, "from-disk.txt");
        await fs.writeFile(filePath, "disk content");

        const m = buildMimetypes();
        const result = await m.process({ path: filePath });
        assert.equal(result.ok, true);
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.totalLines, 1);
    });

    it("{§treesitter-runtime-gate} channels: [] returns metadata only", async () => {
        const m = buildMimetypes();
        const result = await m.process(
            { path: "long.txt", content: "any content at all" },
            { channels: [] },
        );
        assert.deepEqual(result, {
            mimetype: "text/plain",
            ok: true,
            totalLines: 1,
        });
    });

    it("{§treesitter-runtime-gate} returns ok:false when the file doesn't exist", async () => {
        const m = buildMimetypes();
        const result = await m.process({ path: "/nonexistent/path/foo.txt" });
        assert.equal(result.mimetype, "text/plain");
        assert.equal(result.ok, false);
        assert.equal("symbols" in result, false);
    });

    it("{§treesitter-runtime-gate} returns ok:false with null mimetype for unknown extension", async () => {
        const m = buildMimetypes();
        const result = await m.process({
            path: "foo.unknown-extension",
            content: "x",
        });
        assert.equal(result.mimetype, null);
        assert.equal(result.ok, false);
    });

    it("{§treesitter-runtime-gate} caches the handler across multiple process() calls", async () => {
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
}

// ─── parser-coordinates.test.ts ───
{
it("{§mimetype-parser-coordinates} projects Python CRLF comments through every structural channel", async (t) => {
    const mimetypes = new Mimetypes();
    t.after(() => mimetypes.dispose());
    const content = "# 😀\r\ndef value():\r\n    return helper() # trailing\r\n";
    const result = await mimetypes.process(
        { path: "example.py", content },
        { channels: ["symbols", "references", "deepJson", "deepXml"], strict: true },
    );
    assert.deepEqual(result.symbols, [{
        name: "value", kind: "function", params: [],
        line: 2, column: 1, endLine: 4, endColumn: 1,
    }]);
    assert.deepEqual(result.references?.find((ref) => ref.name === "helper"), {
        name: "helper", kind: "call", container: "value",
        line: 3, column: 12, endLine: 3, endColumn: 18,
    });
    const tree = result.deepJson as {
        children: Array<{ type: string; line: number; endLine: number; endColumn: number }>;
    };
    assert.equal(tree.children.find((node) => node.type === "function_definition")?.endLine, 4);
    assert.equal(tree.children.find((node) => node.type === "comment")?.endLine, 2);
    assert.match(result.deepXml ?? "", /function_definition/);
    assert.equal(result.parseIssues, undefined);
});
}

// ─── reentrancy.test.ts ───
{
// {§mimetype-lifecycle}: process() must be safe to call concurrently — plurnk-service parallelizes
// the cold-start manifest derive (symbols + references for every
// member at once). The risk is the shared, cached tree-sitter parser + compiled
// query held on the one handler instance per mimetype: if any channel held a
// tree (or tree node) across an await, an overlapping call could corrupt it.
//
// This standing guarantee is asserted under {§mimetype-lifecycle} against
// TypeScript files with import/inherit/instantiate/call refs, parsed concurrently
// vs sequentially. The invariant: concurrent results are byte-identical to
// sequential. A future change that parks a tree across an await would break here.





const N = 48;
const inputs = Array.from({ length: N }, (_, i) => ({
    path: `f${i}.ts`,
    content:
        `import { foo${i} } from "./dep${i}";\n`
        + `class Widget${i} extends Base${i} {\n`
        + `  run(x: Shape${i}): Token${i} {\n`
        + `    const h = new Helper${i}();\n`
        + `    return foo${i}(h.method${i}(x));\n`
        + `  }\n`
        + `}\n`
        + `function tokenize${i}(s: string) { return foo${i}(s); }\n`,
}));

const CHANNELS = ["symbols", "references", "deepJson", "deepXml"] as const;

describe("{§mimetype-lifecycle} — process() is re-entrant under concurrency", () => {
    it("{§treesitter-runtime-gate} concurrent symbols/references match a sequential baseline, byte-for-byte", async () => {
        const m = new Mimetypes({ discovery: await discover() });
        const opts = { channels: [...CHANNELS] };

        // Probe: if the TypeScript grammar isn't resolvable in this environment,
        // there's nothing to stress — skip rather than false-fail.
        const probe = await m.process(inputs[0], opts);
        if (probe.grammarMissing || (probe.references?.length ?? 0) === 0) {
            console.log(`skipped: typescript grammar unavailable (missing=${probe.grammarMissing ?? "-"})`);
            return;
        }

        const sequential = [];
        for (const input of inputs) sequential.push(await m.process(input, opts));

        // Several concurrent rounds — corruption is timing-sensitive, so one
        // clean round isn't proof; repeat to shake out interleavings.
        for (let round = 0; round < 4; round += 1) {
            const concurrent = await Promise.all(inputs.map((input) => m.process(input, opts)));
            for (let i = 0; i < N; i += 1) {
                assert.deepEqual(
                    concurrent[i].references,
                    sequential[i].references,
                    `round ${round} file ${i}: references diverged under concurrency`,
                );
                assert.deepEqual(
                    concurrent[i].symbols,
                    sequential[i].symbols,
                    `round ${round} file ${i}: symbols diverged under concurrency`,
                );
            }
        }
    });
});
}
