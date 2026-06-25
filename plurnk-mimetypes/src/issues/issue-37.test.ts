// Issue #37: discover() surfaces plurnk.attribution so mimetype plugins can be
// attributed (plurnk-service#249).
// https://github.com/plurnk/plurnk-mimetypes/issues/37
//
// Load-bearing claims, restated as testable contracts:
//
//   C1. A package declaring `plurnk.attribution: "tag"` surfaces that raw
//       string on the discovered handler's metadata.
//   C2. Array form (`["a","b"]`) passes through verbatim, and — being
//       package-level like `binary` — applies to EVERY handler entry in a
//       multi-handler package.
//   C3. A package with no `plurnk.attribution` yields no attribution
//       (undefined) — the field is absent, not an empty value.
//   C4. Malformed declarations are treated as absent by the dumb scanner:
//       empty string, empty array, non-string array elements (filtered), and
//       non-string/array values (number, object). discover() never throws.
//   C5. Tree-sitter built-ins (source "treesitter") carry no attribution.

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

describe("issue #37 — discover() surfaces plurnk.attribution", () => {
    let tmpRoot: string;

    before(async () => {
        tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plurnk-issue37-"));
    });

    after(async () => {
        await fs.rm(tmpRoot, { recursive: true, force: true });
    });

    it("C1: a single-string attribution surfaces verbatim", async () => {
        const dir = await makePackage(tmpRoot, "c1", {
            name: "@acme/acme-mime-foo",
            plurnk: {
                kind: "mimetype",
                attribution: "acme",
                handlers: [{ name: "application/x-foo", glyph: "🅰", extensions: [".foo"] }],
            },
        });
        const { handlers } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.equal(handlers.get("application/x-foo")?.attribution, "acme");
    });

    it("C2: array attribution passes through and applies to every handler in the package", async () => {
        const dir = await makePackage(tmpRoot, "c2", {
            name: "@acme/acme-mime-multi",
            plurnk: {
                kind: "mimetype",
                attribution: ["acme", "acme-pro"],
                handlers: [
                    { name: "application/x-a", glyph: "A", extensions: [".a"] },
                    { name: "application/x-b", glyph: "B", extensions: [".b"] },
                ],
            },
        });
        const { handlers } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        assert.deepEqual(handlers.get("application/x-a")?.attribution, ["acme", "acme-pro"]);
        assert.deepEqual(handlers.get("application/x-b")?.attribution, ["acme", "acme-pro"]);
    });

    it("C3: no attribution declared → undefined", async () => {
        const dir = await makePackage(tmpRoot, "c3", {
            name: "@acme/acme-mime-bare",
            plurnk: {
                kind: "mimetype",
                handlers: [{ name: "application/x-bare", glyph: "·", extensions: [".bare"] }],
            },
        });
        const { handlers } = await discover({ packageDirs: [dir], includeTreeSitter: false });
        const info = handlers.get("application/x-bare");
        assert.ok(info);
        assert.equal(info.attribution, undefined);
        assert.equal("attribution" in info, false);
    });

    it("C4: malformed attribution is treated as absent, never throws", async () => {
        const cases: Array<[string, unknown]> = [
            ["empty-string", ""],
            ["empty-array", []],
            ["number", 7],
            ["object", { tag: "x" }],
        ];
        for (const [folder, value] of cases) {
            const dir = await makePackage(tmpRoot, `c4-${folder}`, {
                name: `@acme/acme-mime-${folder}`,
                plurnk: {
                    kind: "mimetype",
                    attribution: value,
                    handlers: [{ name: `application/x-${folder}`, glyph: "?", extensions: [`.${folder}`] }],
                },
            });
            const { handlers } = await discover({ packageDirs: [dir], includeTreeSitter: false });
            assert.equal(handlers.get(`application/x-${folder}`)?.attribution, undefined, folder);
        }

        // Non-string array elements are filtered; surviving strings are kept.
        const mixed = await makePackage(tmpRoot, "c4-mixed", {
            name: "@acme/acme-mime-mixed",
            plurnk: {
                kind: "mimetype",
                attribution: ["keep", 1, "", null, "also"],
                handlers: [{ name: "application/x-mixed", glyph: "M", extensions: [".mixed"] }],
            },
        });
        const { handlers } = await discover({ packageDirs: [mixed], includeTreeSitter: false });
        assert.deepEqual(handlers.get("application/x-mixed")?.attribution, ["keep", "also"]);
    });

    it("C5: tree-sitter built-ins carry no attribution", async () => {
        const { handlers } = await discover({ packageDirs: [] });
        const treesitter = [...handlers.values()].find((h) => h.source === "treesitter");
        assert.ok(treesitter, "expected at least one tree-sitter handler");
        assert.equal(treesitter.attribution, undefined);
    });
});
