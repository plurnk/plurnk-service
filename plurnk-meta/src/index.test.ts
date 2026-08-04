import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Meta, { TEACHING_CORPUS } from "./index.ts";

test("teaching corpus: the meta owner publishes one exact immutable membership", () => {
    assert.deepEqual(TEACHING_CORPUS, {
        personality: "PLURNK_PERSONALITY.md",
        requirements: "requirements.md",
        schemeDocs: {
            log: "docs/log.md",
            worker: "docs/worker.md",
        },
        questions: "docs/questions.md",
    });
    assert.equal(Object.isFrozen(TEACHING_CORPUS), true);
    assert.equal(Object.isFrozen(TEACHING_CORPUS.schemeDocs), true);
});

test("isTrusted: gate off (unset / empty / '0') trusts everything", () => {
    for (const v of [undefined, "", "0"]) {
        assert.equal(Meta.isTrusted("@acme/rogue", { PLURNK_PLUGINS_TRUSTED_ONLY: v }), true, `gate ${JSON.stringify(v)}`);
    }
});

test("isTrusted: gate on — @plurnk/* always, allowlist admits, everything else refused", () => {
    const env = { PLURNK_PLUGINS_TRUSTED_ONLY: "acme-plugin, @firewolf/firepad" };
    assert.equal(Meta.isTrusted("@plurnk/plurnk-schemes-http", env), true);
    assert.equal(Meta.isTrusted("acme-plugin", env), true);
    assert.equal(Meta.isTrusted("@firewolf/firepad", env), true);
    assert.equal(Meta.isTrusted("evil-plugin", env), false);
    assert.equal(Meta.isTrusted("evil-plugin", { PLURNK_PLUGINS_TRUSTED_ONLY: "1" }), false, "'1' = on, zero third-party");
});

test("declaresKind: one exact string identifies one plugin family", () => {
    assert.equal(Meta.declaresKind({ kind: "exec" }, "exec"), true);
    assert.equal(Meta.declaresKind({ kind: "scheme" }, "exec"), false);
    assert.equal(Meta.declaresKind({ kind: ["exec", "scheme"] }, "exec"), false);
    assert.equal(Meta.declaresKind(null, "exec"), false);
});

test("normalizeAttribution: absent, scalar, and array declarations have one tag-list representation", () => {
    assert.deepEqual(Meta.normalizeAttribution(undefined, "pkg"), []);
    assert.deepEqual(Meta.normalizeAttribution(null, "pkg"), []);
    assert.deepEqual(Meta.normalizeAttribution("npm:jane", "pkg"), ["npm:jane"]);
    assert.deepEqual(
        Meta.normalizeAttribution(["@acme/widgets", "npm:jane"], "pkg"),
        ["@acme/widgets", "npm:jane"],
    );
    assert.deepEqual(Meta.normalizeAttribution([], "pkg"), [], "an authored empty set is the same canonical fact as absence");
});

test("normalizeAttribution: malformed declarations fail at their shared boundary", () => {
    for (const raw of [42, {}, "", ["ok", ""], ["ok", 42]]) {
        assert.throws(
            () => Meta.normalizeAttribution(raw, "pkg"),
            /plugin 'pkg': plurnk\.attribution must be a non-empty string or string\[\]/,
            `invalid declaration ${JSON.stringify(raw)} must not be partially admitted`,
        );
    }
});

test("normalizeAttribution: only @plurnk packages may claim the reserved @plurnk namespace", () => {
    assert.throws(
        () => Meta.normalizeAttribution(["npm:jane", "@plurnk/staff"], "evil-pkg"),
        /'evil-pkg'.*'@plurnk\/' is reserved.*'@plurnk\/staff'/,
    );
    assert.deepEqual(
        Meta.normalizeAttribution("@plurnk/creators/johnny-cash", "@plurnk/plurnk-execs-figma"),
        ["@plurnk/creators/johnny-cash"],
    );
    assert.deepEqual(Meta.normalizeAttribution("@acme/widgets", "evil-pkg"), ["@acme/widgets"]);
});

test("packageDirs: enumerates the fixture plus legitimate packages farther up the open ancestor chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-scan-"));
    try {
        const outer = join(root, "node_modules");
        const nm = join(root, "fixture", "node_modules");
        await mkdir(join(outer, "unrelated-ancestor"), { recursive: true });
        await mkdir(join(nm, "@plurnk", "plurnk-fake"), { recursive: true });
        await mkdir(join(nm, "acme-plugin"), { recursive: true });
        await mkdir(join(nm, ".bin"), { recursive: true });
        await mkdir(join(nm, ".cache"), { recursive: true });
        const real = join(root, "workspace-member");
        await mkdir(real);
        await writeFile(join(real, "package.json"), "{}");
        await symlink(real, join(nm, "@plurnk", "plurnk-linked"));
        const candidates = await Meta.packageDirs(nm);
        const byName = new Map(candidates.map((candidate) => [candidate.name, candidate.dir]));
        assert.equal(byName.size, candidates.length, "each package name has one nearest candidate");
        assert.equal(byName.get("@plurnk/plurnk-fake"), join(nm, "@plurnk", "plurnk-fake"));
        assert.equal(byName.get("@plurnk/plurnk-linked"), join(nm, "@plurnk", "plurnk-linked"));
        assert.equal(byName.get("acme-plugin"), join(nm, "acme-plugin"));
        assert.equal(byName.get("unrelated-ancestor"), join(outer, "unrelated-ancestor"));
        assert.equal(byName.has(".bin"), false);
        assert.equal(byName.has(".cache"), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("packageDirs: missing node_modules yields []", async () => {
    assert.deepEqual(await Meta.packageDirs("/no/such/dir/node_modules"), []);
});

test("packageDirs: merges npm's nested peer graph with ancestor packages, nearest name wins", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugins-chain-"));
    try {
        const outer = join(root, "node_modules");
        const inner = join(root, "packages", "service", "node_modules");
        await mkdir(join(outer, "@plurnk", "plurnk-schemes-http"), { recursive: true });
        await mkdir(join(outer, "@plurnk", "plurnk-providers"), { recursive: true });
        await mkdir(join(outer, "unrelated-ancestor"), { recursive: true });
        await mkdir(join(inner, "@plurnk", "plurnk-providers"), { recursive: true });
        await mkdir(join(inner, "@acme", "ai-provider"), { recursive: true });

        const candidates = await Meta.packageDirs(inner);
        const byName = new Map(candidates.map((candidate) => [candidate.name, candidate.dir]));
        assert.equal(byName.size, candidates.length, "ancestor merging returns one nearest candidate per name");
        assert.equal(byName.get("@acme/ai-provider"), join(inner, "@acme", "ai-provider"));
        assert.equal(byName.get("@plurnk/plurnk-providers"), join(inner, "@plurnk", "plurnk-providers"));
        assert.equal(byName.get("@plurnk/plurnk-schemes-http"), join(outer, "@plurnk", "plurnk-schemes-http"));
        assert.equal(byName.get("unrelated-ancestor"), join(outer, "unrelated-ancestor"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
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
