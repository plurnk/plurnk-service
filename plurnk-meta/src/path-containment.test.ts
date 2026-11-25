import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { isLexicallyWithinDirectory, isWithinDirectory, resolvePhysical } from "./path-containment.ts";

describe("{§operator-config-workspace-settings} physical path containment", () => {
    test("{§operator-config-workspace-settings} isLexicallyWithinDirectory and isWithinDirectory reject escapes, symlinks, dangling symlinks, and symlink loops", async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-meta-contain-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const base = join(root, "workspace");
        const outside = join(root, "outside");
        const siblingPrefix = join(root, "workspace-evil");
        await mkdir(join(base, "sub"), { recursive: true });
        await mkdir(outside, { recursive: true });
        await mkdir(siblingPrefix, { recursive: true });
        await writeFile(join(base, "sub", "ok.md"), "ok");
        await writeFile(join(outside, "secret.md"), "secret");

        assert.equal(isLexicallyWithinDirectory(base, base), true);
        assert.equal(isLexicallyWithinDirectory(base, join(base, "sub", "ok.md")), true);
        assert.equal(isLexicallyWithinDirectory(base, siblingPrefix), false);
        assert.equal(isLexicallyWithinDirectory(base, join(base, "..", "outside")), false);

        assert.equal(await isWithinDirectory(base, base), true);
        assert.equal(await isWithinDirectory(base, join(base, "sub", "ok.md")), true);
        assert.equal(await isWithinDirectory(base, join(base, "sub", "missing.md")), true);
        assert.equal(await isWithinDirectory(base, siblingPrefix), false);
        assert.equal(await isWithinDirectory(base, outside), false);

        // Live symlink escaping base
        const escapeLink = join(base, "escape");
        await symlink(outside, escapeLink);
        assert.equal(await isWithinDirectory(base, escapeLink), false);
        assert.equal(await isWithinDirectory(base, join(escapeLink, "secret.md")), false);

        // Dangling symlink escaping base
        const danglingEscape = join(base, "dangling");
        await symlink(join(outside, "nonexistent.md"), danglingEscape);
        assert.equal(await isWithinDirectory(base, danglingEscape), false);

        // Inward symlink remains contained
        const inwardLink = join(base, "inward.md");
        await symlink(join(base, "sub", "ok.md"), inwardLink);
        assert.equal(await isWithinDirectory(base, inwardLink), true);
        assert.equal(await resolvePhysical(inwardLink), await resolvePhysical(join(base, "sub", "ok.md")));

        // Symlink loop returns false rather than throwing
        const loopA = join(base, "loop-a");
        const loopB = join(base, "loop-b");
        await symlink(loopB, loopA);
        await symlink(loopA, loopB);
        assert.equal(await isWithinDirectory(base, loopA), false);
    });
});
