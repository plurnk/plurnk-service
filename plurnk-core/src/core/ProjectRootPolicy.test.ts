import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import ProjectRootPolicy, { PROJECT_ROOT_BASE_KEY } from "./ProjectRootPolicy.ts";
import { OperationFailureError } from "./results.ts";

describe("ProjectRootPolicy", () => {
    test("{§operator-config-workspace-settings} parse resolves unrestricted, none, absolute, and ~/ base paths and rejects malformed values", () => {
        assert.deepEqual(ProjectRootPolicy.parse({}), { mode: "unrestricted", base: null });
        assert.deepEqual(ProjectRootPolicy.parse({ [PROJECT_ROOT_BASE_KEY]: "" }), { mode: "unrestricted", base: null });
        assert.deepEqual(ProjectRootPolicy.parse({ [PROJECT_ROOT_BASE_KEY]: "none" }), { mode: "none", base: null });
        assert.deepEqual(
            ProjectRootPolicy.parse({ [PROJECT_ROOT_BASE_KEY]: "/srv/tenants/" }),
            { mode: "confined", base: "/srv/tenants" },
        );
        assert.deepEqual(
            ProjectRootPolicy.parse({ HOME: "/home/ada", [PROJECT_ROOT_BASE_KEY]: "~/tenants" }),
            { mode: "confined", base: "/home/ada/tenants" },
        );
        assert.deepEqual(
            ProjectRootPolicy.parse({ [PROJECT_ROOT_BASE_KEY]: "~" }, "/custom/home"),
            { mode: "confined", base: "/custom/home" },
        );

        for (const bad of ["relative/path", "./tenants", "  ", " none ", "\uD800/bad", "/bad\0path"]) {
            assert.throws(
                () => ProjectRootPolicy.parse({ [PROJECT_ROOT_BASE_KEY]: bad }),
                (error: unknown) => error instanceof ConfigurationError && error.key === PROJECT_ROOT_BASE_KEY,
                `expected ConfigurationError for ${JSON.stringify(bad)}`,
            );
        }
    });

    test("{§operator-config-workspace-settings} clampScope composes the 3x3 confinement and scope matrix", () => {
        for (const scope of ["none", "root", "namespace"] as const) {
            assert.equal(ProjectRootPolicy.clampScope(scope, { [PROJECT_ROOT_BASE_KEY]: "" }), scope);
            assert.equal(ProjectRootPolicy.clampScope(scope, { [PROJECT_ROOT_BASE_KEY]: "none" }), "none");
        }
        assert.equal(ProjectRootPolicy.clampScope("none", { [PROJECT_ROOT_BASE_KEY]: "/srv/tenants" }), "none");
        assert.equal(ProjectRootPolicy.clampScope("root", { [PROJECT_ROOT_BASE_KEY]: "/srv/tenants" }), "root");
        assert.equal(ProjectRootPolicy.clampScope("namespace", { [PROJECT_ROOT_BASE_KEY]: "/srv/tenants" }), "root");
    });

    test("{§operator-config-workspace-settings} staticPrefixOfGlob extracts leading literal segments before any glob syntax", () => {
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob(""), "");
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob("**"), "");
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob("*.md"), "");
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob("docs/**"), "docs");
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob("a/b/*.ts"), "a/b");
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob("a/*/c"), "a");
        assert.equal(ProjectRootPolicy.staticPrefixOfGlob("docs/guide.md"), "docs/guide.md");
    });

    test("{§operator-config-workspace-settings} isWithinDirectory enforces physical realpath containment across subdirs, siblings, symlinks, dangling symlinks, and loops", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-root-policy-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const base = join(scratch, "tenants");
        const sibling = join(scratch, "tenants2");
        const inside = join(base, "alice");
        await mkdir(inside, { recursive: true });
        await mkdir(sibling, { recursive: true });
        await writeFile(join(sibling, "secret.txt"), "top secret\n");
        await writeFile(join(inside, "..dotdot-named"), "safe literal file\n");

        const escapeLink = join(inside, "escape");
        const insideLink = join(inside, "alias");
        const danglingEscape = join(inside, "dangling");
        const loopA = join(inside, "loop-a");
        const loopB = join(inside, "loop-b");
        await symlink(sibling, escapeLink);
        await symlink(inside, insideLink);
        await symlink(join(sibling, "nonexistent-dir"), danglingEscape);
        await symlink(loopB, loopA);
        await symlink(loopA, loopB);

        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, base), true);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, inside), true);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, join(base, "future-tenant", "home")), true);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, join(inside, "..dotdot-named")), true);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, insideLink), true);

        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, sibling), false);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, join(sibling, "secret.txt")), false);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, escapeLink), false);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, join(escapeLink, "secret.txt")), false);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, danglingEscape), false);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, join(danglingEscape, "new.txt")), false);
        assert.equal(await ProjectRootPolicy.isWithinDirectory(base, loopA), false);
    });

    test("{§operator-config-workspace-settings} assertAdmitted enforces unrestricted, none, confined, and invalid policy without leaking the base path", async (t) => {
        const scratch = await mkdtemp(join(tmpdir(), "plurnk-root-admit-"));
        t.after(() => rm(scratch, { recursive: true, force: true }));
        const base = join(scratch, "secret-tenant-root");
        const allowed = join(base, "team-a");
        const outside = join(scratch, "outside");
        await mkdir(allowed, { recursive: true });
        await mkdir(outside, { recursive: true });

        await ProjectRootPolicy.assertAdmitted(outside, { [PROJECT_ROOT_BASE_KEY]: "" });
        await ProjectRootPolicy.assertAdmitted(null, { [PROJECT_ROOT_BASE_KEY]: "none" });
        await ProjectRootPolicy.assertAdmitted(null, { [PROJECT_ROOT_BASE_KEY]: base });
        await ProjectRootPolicy.assertAdmitted(allowed, { [PROJECT_ROOT_BASE_KEY]: base });

        await assert.rejects(
            () => ProjectRootPolicy.assertAdmitted(allowed, { [PROJECT_ROOT_BASE_KEY]: "none" }),
            (error: unknown) =>
                error instanceof OperationFailureError
                && error.result.status === 403
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/workspace/project-root-forbidden",
        );

        await assert.rejects(
            () => ProjectRootPolicy.assertAdmitted(outside, { [PROJECT_ROOT_BASE_KEY]: base }),
            (error: unknown) => {
                if (!(error instanceof OperationFailureError)) return false;
                if (error.result.status !== 403 || error.result.problem?.type !== "https://problems.plurnk.xyz/daemon/workspace/project-root-confined") return false;
                const serialized = JSON.stringify(error.result);
                assert.equal(serialized.includes("secret-tenant-root"), false, "base path must not leak in Problem");
                assert.equal(serialized.includes(resolve(base)), false, "resolved base path must not leak in Problem");
                return true;
            },
        );

        await assert.rejects(
            () => ProjectRootPolicy.assertAdmitted(allowed, { [PROJECT_ROOT_BASE_KEY]: "relative/bad" }),
            (error: unknown) =>
                error instanceof OperationFailureError
                && error.result.status === 503
                && error.result.problem?.type === "https://problems.plurnk.xyz/daemon/configuration/configuration-invalid",
        );
    });
});
