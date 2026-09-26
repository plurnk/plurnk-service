import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Digest from "@plurnk/plurnk-service/digest";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated } from "./_helpers.ts";

const execFileP = promisify(execFile);

for (const kind of ["parent", "ancestor", "database", "input-alias", "output-alias", "linked-parent", "lexical-input-alias", "linked-input-parent"] as const) {
    test(`{§digest-programmatic-surface}: ${kind} output cannot remove its input`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-digest-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const directory = join(root, "evidence");
        await mkdir(directory);
        const original = join(directory, "plurnk.db");
        const db = await openMigrated(original);
        await db.close();
        await writeFile(join(directory, "witness.txt"), "preserve source evidence");
        const before = await readFile(original);
        let dbPath = original;
        let digestDir = directory;
        if (kind === "ancestor") digestDir = root;
        if (kind === "database") digestDir = original;
        if (kind === "input-alias") {
            dbPath = join(root, "input.db");
            await symlink(original, dbPath);
        }
        if (kind === "output-alias") {
            digestDir = join(root, "output");
            await symlink(directory, digestDir, "dir");
        }
        if (kind === "linked-parent") {
            const alias = join(root, "alias");
            await symlink(root, alias, "dir");
            digestDir = join(alias, "evidence");
        }
        if (kind === "lexical-input-alias" || kind === "linked-input-parent") {
            const external = join(root, "external.db");
            const externalDb = await openMigrated(external);
            await externalDb.close();
            dbPath = join(directory, "input.db");
            await symlink(external, dbPath);
            if (kind === "linked-input-parent") {
                const alias = join(root, "input-directory");
                await symlink(directory, alias, "dir");
                dbPath = join(alias, "input.db");
            }
        }
        let failure: unknown;
        try { Digest.run({ dbPath, digestDir }); }
        catch (cause) { failure = cause; }
        assert.equal(existsSync(original), true, "digest must preserve the database pathname");
        assert.equal(existsSync(dbPath), true, "digest must preserve the caller's input pathname");
        assert.ok((await readFile(original)).equals(before), "digest must preserve its input database bytes");
        assert.equal(await readFile(join(directory, "witness.txt"), "utf8"), "preserve source evidence");
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, `digest: output directory ${resolve(digestDir)} overlaps input database ${resolve(dbPath)}`);
    });
}

test("{§digest-programmatic-surface}: a sibling with the database's filename prefix remains valid and refreshable", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-sibling-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "evidence.db");
    const db = await openMigrated(dbPath);
    await db.close();
    const digestDir = join(root, "evidence");
    await mkdir(digestDir);
    await writeFile(join(digestDir, "packet999.user.md"), "stale");
    Digest.run({ dbPath, digestDir });
    assert.equal(existsSync(dbPath), true);
    assert.equal(existsSync(join(digestDir, "packet999.user.md")), false);
    assert.deepEqual(JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8")).workspaces, []);
    Digest.run({ dbPath, digestDir: join(digestDir, "nested") });
    assert.equal(existsSync(join(digestDir, "nested", "digest.md")), true);
});

for (const entrypoint of ["CLI", "built package"]) {
    test(`{§digest-programmatic-surface}: the ${entrypoint} reports overlap without removing input evidence`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-digest-cli-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, "plurnk.db");
        const db = await openMigrated(dbPath);
        await db.close();
        const args = entrypoint === "CLI"
            ? ["--conditions=plurnk-dev", "src/service.ts", "share", dbPath, root]
            : ["--input-type=module", "--eval", `
                import Digest from "@plurnk/plurnk-service/digest";
                Digest.run(${JSON.stringify({ dbPath, digestDir: root })});
            `];
        await assert.rejects(execFileP(process.execPath, args, {
            cwd: resolve(import.meta.dirname, "../.."),
        }), (cause: unknown) => {
            assert.ok(cause instanceof Error);
            const failure = cause as Error & { code: number; stderr: string };
            assert.equal(failure.code, 1);
            assert.ok(failure.stderr.includes(`digest: output directory ${root} overlaps input database ${dbPath}`));
            return true;
        });
        assert.equal(existsSync(dbPath), true);
    });
}

test("{§digest-programmatic-surface}: an empty output path is not the caller's working directory", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-digest-empty-output-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dbPath = join(root, "plurnk.db");
    await writeFile(dbPath, "not opened during output validation");
    assert.throws(() => Digest.run({ dbPath, digestDir: "" }), {
        message: "digest: output directory must not be empty",
    });
    assert.equal(await readFile(dbPath, "utf8"), "not opened during output validation");
});

for (const name of ["requiem.json", "requiem.md"]) {
    test(`{§digest-programmatic-surface}: requiem cannot overwrite a database named ${name}`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-overlap-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, name);
        const db = await openMigrated(dbPath);
        await db.close();
        const before = await readFile(dbPath);
        let failure: unknown;
        try { await Digest.requiem({ dbPath, digestDir: root, provider: new Mock({ contextWindow: 8192, responses: [] }) }); }
        catch (cause) { failure = cause; }
        assert.ok((await readFile(dbPath)).equals(before), "requiem must preserve its input database bytes");
        assert.ok(failure instanceof Error);
        assert.equal(failure.message, `digest: output directory ${root} overlaps input database ${dbPath}`);
    });
}
