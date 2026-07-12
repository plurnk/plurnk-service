import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Meta from "./index.ts";

test("isTrusted: gate off (unset / empty / '0') trusts everything", () => {
    for (const v of [undefined, "", "0"]) {
        assert.equal(Meta.isTrusted("@acme/rogue", { PLURNK_PLUGINS_TRUSTED_ONLY: v }), true, `gate ${JSON.stringify(v)}`);
    }
});

test("isTrusted: gate on — @plurnk/* always, allowlist admits, everything else refused", () => {
    const env = { PLURNK_PLUGINS_TRUSTED_ONLY: "acme-plugin, @firewolf/firepad" };
    assert.equal(Meta.isTrusted("@plurnk/plurnk-execs-mcp", env), true);
    assert.equal(Meta.isTrusted("acme-plugin", env), true);
    assert.equal(Meta.isTrusted("@firewolf/firepad", env), true);
    assert.equal(Meta.isTrusted("evil-plugin", env), false);
    assert.equal(Meta.isTrusted("evil-plugin", { PLURNK_PLUGINS_TRUSTED_ONLY: "1" }), false, "'1' = on, zero third-party");
});

test("packageDirs: enumerates scoped + unscoped, follows symlinks, skips .bin/.cache/dotfiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-scan-"));
    try {
        const nm = join(root, "node_modules");
        await mkdir(join(nm, "@plurnk", "plurnk-fake"), { recursive: true });
        await mkdir(join(nm, "acme-plugin"), { recursive: true });
        await mkdir(join(nm, ".bin"), { recursive: true });
        const real = join(root, "workspace-member");
        await mkdir(real);
        await writeFile(join(real, "package.json"), "{}");
        await symlink(real, join(nm, "@plurnk", "plurnk-linked"));
        const names = (await Meta.packageDirs(nm)).map((c) => c.name).toSorted();
        assert.deepEqual(names, ["@plurnk/plurnk-fake", "@plurnk/plurnk-linked", "acme-plugin"], "symlinked workspace member enumerated; .bin skipped");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("packageDirs: missing node_modules yields []", async () => {
    assert.deepEqual(await Meta.packageDirs("/no/such/dir/node_modules"), []);
});

test("nearestNodeModules: finds the ancestor holding @plurnk; null when absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-walk-"));
    try {
        await mkdir(join(root, "node_modules", "@plurnk"), { recursive: true });
        const deep = join(root, "packages", "member", "src");
        await mkdir(deep, { recursive: true });
        // a sparse per-package node_modules (bins only) must NOT win the walk
        await mkdir(join(root, "packages", "member", "node_modules", ".bin"), { recursive: true });
        assert.equal(Meta.nearestNodeModules(deep), join(root, "node_modules"));
        assert.equal(Meta.nearestNodeModules(tmpdir()), null, "no ecosystem anywhere up the tree");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
