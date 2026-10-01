import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

test("external census keeps both clients independent of managed platform extensions", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-external-census-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of ["plurnk", "plurnk-web", "plurnk-schemes-example"]) {
        const directory = join(root, name);
        await mkdir(join(directory, ".git"), { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({
            name: `@plurnk/${name}`,
            dependencies: { "@plurnk/plurnk-contracts": "^1.25.0" },
        }));
    }
    const { stdout } = await run(process.execPath, [fileURLToPath(new URL("../plurnk-meta/scripts/external-package-census.mjs", import.meta.url))], {
        env: { ...process.env, PLURNK_EXTERNAL_REPOS_ROOT: root },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.managed, 1);
    assert.equal(result.independent, 2);
    assert.deepEqual(result.packages.map(({ dir, release, owner }) => ({ dir, release, owner })), [
        { dir: "plurnk", release: "independent", owner: "client" },
        { dir: "plurnk-schemes-example", release: "managed", owner: "schemes" },
        { dir: "plurnk-web", release: "independent", owner: "client" },
    ]);
});
