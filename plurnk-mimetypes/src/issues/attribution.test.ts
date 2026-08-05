import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discover } from "../discover.ts";

async function makePackage(
    root: string,
    folder: string,
    pkg: Record<string, unknown>,
): Promise<string> {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    return dir;
}

describe("discover attribution", () => {
    let tmpRoot: string;

    before(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-attribution-"));
    });

    after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("a single-string attribution surfaces through both representations", async () => {
        const dir = await makePackage(tmpRoot, "c1", {
            name: "@acme/acme-mime-foo",
            plurnk: {
                kind: "mimetype",
                attribution: "acme",
                handlers: [{ name: "application/x-foo", revision: "test-1", glyph: "🅰", extensions: [".foo"] }],
            },
        });
        const { handlers, packageAttributions } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(handlers.get("application/x-foo")?.attribution, "acme");
        assert.deepEqual(packageAttributions.get("@acme/acme-mime-foo"), ["acme"]);
    });

    it("one canonical package attribution projects onto every published handler descriptor", async () => {
        const dir = await makePackage(tmpRoot, "c2", {
            name: "@acme/acme-mime-multi",
            plurnk: {
                kind: "mimetype",
                attribution: ["acme", "acme-pro"],
                handlers: [
                    { name: "application/x-a", revision: "test-1", glyph: "A", extensions: [".a"] },
                    { name: "application/x-b", revision: "test-1", glyph: "B", extensions: [".b"] },
                ],
            },
        });
        const { handlers, packageAttributions } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.deepEqual(handlers.get("application/x-a")?.attribution, ["acme", "acme-pro"]);
        assert.deepEqual(handlers.get("application/x-b")?.attribution, ["acme", "acme-pro"]);
        assert.deepEqual([...packageAttributions], [["@acme/acme-mime-multi", ["acme", "acme-pro"]]]);
    });

    it("an absent attribution produces no package fact or handler projection", async () => {
        const dir = await makePackage(tmpRoot, "c3", {
            name: "@acme/acme-mime-bare",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "application/x-bare", revision: "test-1", glyph: "·", extensions: [".bare"] }],
            },
        });
        const { handlers, packageAttributions } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        const info = handlers.get("application/x-bare");
        assert.ok(info);
        assert.equal(info.attribution, undefined);
        assert.equal("attribution" in info, false);
        assert.equal(packageAttributions.size, 0);
    });

    it("a trusted malformed attribution fails whole-package admission", async () => {
        const cases: Array<[string, unknown]> = [["empty-string", ""], ["number", 7], ["object", { tag: "x" }], ["mixed", ["keep", 1]]];
        for (const [folder, value] of cases) {
            const dir = await makePackage(tmpRoot, `c4-${folder}`, {
                name: `@acme/acme-mime-${folder}`,
                plurnk: {
                    kind: "mimetype",
                    attribution: value,
                    handlers: [{ name: `application/x-${folder}`, revision: "test-1", glyph: "?", extensions: [`.${folder}`] }],
                },
            });
            await assert.rejects(
                discover({ packageDirs: [dir], includeTreeSitter: false }),
                /plurnk\.attribution must be a non-empty string or string\[\]/,
                folder,
            );
        }

        const reserved = await makePackage(tmpRoot, "reserved", {
            name: "@acme/acme-mime-reserved",
            plurnk: {
                kind: "mimetype",
                attribution: "@plurnk/staff",
                handlers: [{ name: "application/x-reserved", revision: "test-1", extensions: [".reserved"] }],
            },
        });
        await assert.rejects(discover({ packageDirs: [reserved], includeTreeSitter: false }), /'@plurnk\/' is reserved/);
    });

    it("an untrusted malformed attribution is withheld before validation", async () => {
        const dir = await makePackage(tmpRoot, "untrusted-invalid", {
            name: "@acme/acme-mime-untrusted",
            plurnk: {
                kind: "mimetype",
                attribution: ["keep", 1],
                handlers: [{ name: "application/x-untrusted", revision: "test-1", extensions: [".untrusted"] }],
            },
        });
        const result = await discover({
            packageDirs: [dir],
            includeTreeSitter: false,
            env: { PLURNK_PLUGINS_TRUSTED_ONLY: "1" },
        });
        assert.deepEqual(result.skipped, ["@acme/acme-mime-untrusted"]);
        assert.equal(result.packageAttributions.size, 0);
    });

    it("tree-sitter built-ins carry no package attribution", async () => {
        const { handlers, packageAttributions } = await discover({ packageDirs: [] });
        const treesitter = [...handlers.values()].find((h) => h.source === "treesitter");
        assert.ok(treesitter, "expected at least one tree-sitter handler");
        assert.equal(treesitter.attribution, undefined);
        assert.equal(packageAttributions.size, 0);
    });
});
