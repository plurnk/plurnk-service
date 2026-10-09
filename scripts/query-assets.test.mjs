import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packageArtifactViolations } from "./package-artifacts.mjs";

const run = promisify(execFile);

test("{§mimetype-query-assets} built query loading is contained in the packed package", async () => {
    const workspace = fileURLToPath(new URL("../plurnk-mimetypes/", import.meta.url));
    const directory = await mkdtemp(join(tmpdir(), "plurnk-query-assets-"));
    try {
        const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: workspace });
        const [packed] = JSON.parse(stdout);
        assert.deepEqual(packageArtifactViolations("plurnk-mimetypes", packed.files.map(({ path }) => path)), []);
        await run("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
        const root = join(directory, "package");
        const { loadRefsQuery } = await import(pathToFileURL(join(root, "dist/treesitter/reference-query.js")).href);
        const assets = (await readdir(join(workspace, "queries"))).filter((name) => name.endsWith(".scm"));
        assert.ok(assets.length > 0);
        for (const file of assets) {
            assert.equal(await loadRefsQuery(file.slice(0, -4)),
                await readFile(join(workspace, "queries", file), "utf8"), file);
        }
        await rm(join(root, "queries", "python.scm"));
        await assert.rejects(loadRefsQuery("python"), { code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
