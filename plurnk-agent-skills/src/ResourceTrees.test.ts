import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
    ContainedDirectoryTree,
    InlineResourceTree,
    SingleFileResourceTree,
    SkillResourceError,
    assertContainedPath,
} from "./ResourceTrees.ts";
import { parseSkill } from "./SkillDocument.ts";

describe("ResourceTrees", () => {
    test("{§provided-skills-module-slice} {§agent-skills-directory} ContainedDirectoryTree lists nested files, reads slices, and blocks escapes or symlink cycles", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-res-tree-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dir = join(root, "reviewer");
        await mkdir(join(dir, "refs"), { recursive: true });
        await writeFile(join(root, "outside.txt"), "secret");
        const docSource = "---\nname: reviewer\ndescription: Code reviewer\n---\nReview carefully.\n";
        await writeFile(join(dir, "PERSONA.md"), docSource);
        await writeFile(join(dir, "refs", "checklist.md"), "# Checklist\n");

        const canonical = await realpath(dir);
        const doc = parseSkill(join(canonical, "PERSONA.md"), "reviewer", docSource);
        const tree = new ContainedDirectoryTree(canonical, doc, "Persona");

        assert.deepEqual(await tree.list(), ["PERSONA.md", "refs/checklist.md"]);
        assert.equal((await tree.read("refs/checklist.md")).toString("utf8"), "# Checklist\n");
        const size = await tree.resource("PERSONA.md").size();
        assert.equal(size, Buffer.byteLength(docSource));

        await assert.rejects(() => tree.resolve("/etc/passwd"), (err: unknown) => {
            assert.ok(err instanceof SkillResourceError);
            assert.equal(err.code, "SKILL_PATH_OUTSIDE_ROOT");
            return true;
        });
        await assert.rejects(() => tree.resolve("../outside.txt"), (err: unknown) => {
            assert.ok(err instanceof SkillResourceError);
            assert.equal(err.code, "SKILL_PATH_OUTSIDE_ROOT");
            return true;
        });
        await assert.rejects(() => tree.resolve("refs"), (err: unknown) => {
            assert.ok(err instanceof SkillResourceError);
            assert.equal(err.code, "SKILL_RESOURCE_NOT_FILE");
            return true;
        });

        await symlink(join(root, "outside.txt"), join(dir, "escape.txt"));
        await assert.rejects(() => tree.resolve("escape.txt"), (err: unknown) => {
            assert.ok(err instanceof SkillResourceError);
            assert.equal(err.code, "SKILL_PATH_OUTSIDE_ROOT");
            return true;
        });
        await rm(join(dir, "escape.txt"));

        await symlink(canonical, join(dir, "refs", "loop"));
        await assert.rejects(() => tree.list(), (err: unknown) => {
            assert.ok(err instanceof SkillResourceError);
            assert.equal(err.code, "SKILL_DIRECTORY_CYCLE");
            return true;
        });

        assert.throws(
            () => assertContainedPath(canonical, join(root, "outside.txt"), "../outside.txt", "Persona"),
            /resolves outside its persona directory/u,
        );
    });

    test("{§provided-skills-module-slice} SingleFileResourceTree and InlineResourceTree expose one entry and refuse path traversal", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-single-tree-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const docSource = "---\nname: architect\ndescription: System architect\n---\nDesign cleanly.\n";
        const file = join(root, "architect.md");
        await writeFile(file, docSource);
        const doc = parseSkill(file, "architect", docSource);

        const single = new SingleFileResourceTree(file, doc, "PERSONA.md", "Persona");
        assert.deepEqual(await single.list(), ["PERSONA.md"]);
        assert.equal(await single.resource("PERSONA.md").size(), Buffer.byteLength(docSource));
        assert.equal(await single.resource("missing.md").size(), null);
        await assert.rejects(() => single.resource("../secret").size(), SkillResourceError);

        const inline = new InlineResourceTree(doc, "PERSONA.md", "Persona");
        assert.deepEqual(await inline.list(), ["PERSONA.md"]);
        const inlineSize = await inline.resource("PERSONA.md").size();
        assert.equal(inlineSize, Buffer.byteLength(docSource));
        assert.equal(new TextDecoder().decode(await inline.resource("PERSONA.md").read(1, inlineSize)), docSource);
        assert.equal(await inline.resource("other.md").size(), null);
        await assert.rejects(() => inline.resource("/abs/path").size(), SkillResourceError);
    });
});
