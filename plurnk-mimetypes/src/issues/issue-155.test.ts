// Contracts: {§mimetype-embedding}, {§mimetype-tokenizer}.
// Issue #155 is provenance.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import Mimetypes from "../Mimetypes.ts";
import type { Discovery } from "../types.ts";

const EMBEDDINGS_PACKAGE = "@plurnk/plurnk-mimetypes-embeddings";
const TOKENIZERS_PACKAGE = "@plurnk/plurnk-mimetypes-tokenizers";
const roots: string[] = [];

const emptyDiscovery = (): Discovery => ({
    registry: { byExtension: new Map(), byFilename: new Map() },
    handlers: new Map(),
    skipped: [],
});

async function fixtureRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-artifact-load-"));
    roots.push(root);
    return root;
}

async function installFixture(root: string, packageName: string, source: string): Promise<void> {
    const packageRoot = path.join(root, "node_modules", ...packageName.split("/"));
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
        name: packageName,
        type: "module",
        exports: "./index.js",
    }));
    await writeFile(path.join(packageRoot, "index.js"), source);
}

const fromRoot = (cwd: string): Mimetypes => new Mimetypes({
    discoverOptions: { cwd },
    discovery: emptyDiscovery(),
});

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fixed artifact module absence", () => {
    it("degrades only when the exact requested artifacts are absent", async () => {
        const mimetypes = fromRoot(await fixtureRoot());

        assert.equal(await mimetypes.embedderInfo(), null);
        assert.equal((await mimetypes.tokenizer("model/ref")).exact, false);
    });

    it("surfaces an embeddings artifact's missing nested dependency", async () => {
        const root = await fixtureRoot();
        await installFixture(root, EMBEDDINGS_PACKAGE, "import '@fixture/missing-embedding-dependency';\n");

        await assert.rejects(
            () => fromRoot(root).embedderInfo(),
            (error: Error & { code?: string }) => {
                assert.equal(error.code, "ERR_MODULE_NOT_FOUND");
                assert.match(error.message, /@fixture\/missing-embedding-dependency/);
                return true;
            },
        );
    });

    it("surfaces a tokenizers artifact's missing nested dependency", async () => {
        const root = await fixtureRoot();
        await installFixture(
            root,
            TOKENIZERS_PACKAGE,
            "import { createRequire } from 'node:module';\n"
            + "createRequire(import.meta.url)('@fixture/missing-tokenizer-dependency');\n",
        );

        await assert.rejects(
            () => fromRoot(root).tokenizer("model/ref"),
            (error: Error & { code?: string }) => {
                assert.equal(error.code, "MODULE_NOT_FOUND");
                assert.match(error.message, /@fixture\/missing-tokenizer-dependency/);
                return true;
            },
        );
    });

    it("surfaces a non-resolution failure thrown while importing an installed artifact", async () => {
        const root = await fixtureRoot();
        await installFixture(root, EMBEDDINGS_PACKAGE, "throw new RangeError('installed artifact failed');\n");

        await assert.rejects(
            () => fromRoot(root).embedderInfo(),
            (error: Error) => {
                assert.ok(error instanceof RangeError);
                assert.equal(error.message, "installed artifact failed");
                return true;
            },
        );
    });
});
