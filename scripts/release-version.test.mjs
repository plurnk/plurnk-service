import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
const root = fileURLToPath(new URL("../", import.meta.url));

const fixture = async (t, manifests, changesets) => {
    const cwd = await mkdtemp(path.join(tmpdir(), "plurnk-release-version-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(path.join(cwd, ".changeset"));
    await symlink(path.join(root, "node_modules"), path.join(cwd, "node_modules"), "dir");
    const json = (file, value) => writeFile(path.join(cwd, file), `${JSON.stringify(value, null, 2)}\n`);
    await json("package.json", { name: "release-fixture", private: true, version: "1.0.0", workspaces: ["packages/*"] });
    await json("package-lock.json", { name: "release-fixture", version: "1.0.0", lockfileVersion: 3, packages: {} });
    await writeFile(path.join(cwd, ".changeset/config.json"), await readFile(path.join(root, ".changeset/config.json")));
    for (const [name, fields] of Object.entries(manifests)) {
        await mkdir(path.join(cwd, "packages", name), { recursive: true });
        await json(`packages/${name}/package.json`, { name, version: "2.0.0", ...fields });
    }
    for (const [index, releases] of changesets.entries()) {
        await writeFile(path.join(cwd, `.changeset/change-${index}.md`),
            `---\n${Object.entries(releases).map(([name, type]) => `${JSON.stringify(name)}: ${type}`).join("\n")}\n---\n\nA package change.\n`);
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd, env });
    await run("git", ["-c", "core.hooksPath=/dev/null", "add", ".changeset", "package.json", "packages"], { cwd, env });
    await run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Release test", "-c", "user.email=release@example.test", "commit", "-qm", "test: release fixture"], { cwd, env });
    return {
        version: async () => {
            await run(process.execPath, [cli, "version"], { cwd, env });
            return Object.fromEntries(await Promise.all(Object.keys(manifests).map(async (name) => [
                name, JSON.parse(await readFile(path.join(cwd, `packages/${name}/package.json`), "utf8")),
            ])));
        },
    };
};

for (const type of ["patch", "minor"]) {
    test(`{§package-release-contract} a ${type} leaves compatible consumers and unrelated packages unchanged`, async (t) => {
        const f = await fixture(t, {
            framework: {},
            consumer: { dependencies: { framework: "^2.0.0" } },
            extension: { peerDependencies: { framework: "^2.0.0" } },
            unrelated: { version: "4.7.3" },
        }, [{ framework: type }]);
        const result = await f.version();
        assert.equal(result.framework.version, type === "patch" ? "2.0.1" : "2.1.0");
        assert.equal(result.consumer.version, "2.0.0");
        assert.equal(result.extension.version, "2.0.0");
        assert.equal(result.unrelated.version, "4.7.3");
        assert.equal(result.consumer.dependencies.framework, "^2.0.0");
        assert.equal(result.extension.peerDependencies.framework, "^2.0.0");
    });
}

test("{§package-release-contract} adopting an exact dependency fix creates a consumer patch, not a minor", async (t) => {
    const f = await fixture(t, {
        provider: {}, service: { dependencies: { provider: "2.0.0" } }, unrelated: {},
    }, [{ provider: "patch" }]);
    const result = await f.version();
    assert.equal(result.provider.version, "2.0.1");
    assert.equal(result.service.version, "2.0.1");
    assert.equal(result.service.dependencies.provider, "2.0.1");
    assert.equal(result.unrelated.version, "2.0.0");
});

test("{§package-release-contract} a dependency major updates its consumer requirement without copying its major", async (t) => {
    const f = await fixture(t, {
        framework: {}, consumer: { dependencies: { framework: "^2.0.0" } }, unrelated: {},
    }, [{ framework: "major" }]);
    const result = await f.version();
    assert.equal(result.framework.version, "3.0.0");
    assert.equal(result.consumer.version, "2.0.1");
    assert.equal(result.consumer.dependencies.framework, "^3.0.0");
    assert.equal(result.unrelated.version, "2.0.0");
});

test("{§package-release-contract} platform functionality has explicit minor intent and coalesces into one release", async (t) => {
    const f = await fixture(t, {
        mcp: {}, service: { dependencies: { mcp: "2.0.0" } }, unrelated: {},
    }, [{ mcp: "minor", service: "minor" }, { mcp: "patch", service: "minor" }]);
    const result = await f.version();
    assert.equal(result.mcp.version, "2.1.0");
    assert.equal(result.service.version, "2.1.0");
    assert.equal(result.service.dependencies.mcp, "2.1.0");
    assert.equal(result.unrelated.version, "2.0.0");
});

test("{§package-release-contract} compatible peer ranges survive an extension's independent fix", async (t) => {
    const f = await fixture(t, {
        framework: {}, extension: { peerDependencies: { framework: "^2.0.0" } },
    }, [{ framework: "minor", extension: "patch" }]);
    const result = await f.version();
    assert.equal(result.framework.version, "2.1.0");
    assert.equal(result.extension.version, "2.0.1");
    assert.equal(result.extension.peerDependencies.framework, "^2.0.0");
});
