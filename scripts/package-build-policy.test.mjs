import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { packRecords, viewManifest } from "./lib/npm-json.mjs";
import { packageArtifactViolations } from "./lib/package-artifacts.mjs";
import { DEV_CONDITION, projectManifest } from "./lib/package-projection.mjs";
import { packageBuildViolations, shipsDist } from "./package-build-policy.mjs";
import { checkPackageTypes } from "./package-types.mjs";

const run = promisify(execFile);

const validBuild = {
    files: ["dist/**/*", "README.md"],
    scripts: {
        "build:clean": "rm -rf dist",
        "build:dist": "tsc -p tsconfig.build.json",
        build: "npm run build:clean && npm run build:dist",
        prepack: "npm run build",
    },
};

test("{§packed-projection} package build policy derives its scope from the published dist projection and enforces one clean owner", () => {
    assert.equal(shipsDist(validBuild), true);
    assert.equal(shipsDist({ files: ["assets/**/*"] }), false);
    assert.equal(shipsDist({ files: ["!dist/private.js", "src/**/*"] }), false);
    assert.deepEqual(packageBuildViolations("asset-only", { files: ["assets/**/*"] }), []);
    assert.deepEqual(packageBuildViolations("private", { ...validBuild, private: true }), []);
    assert.deepEqual(packageBuildViolations("coherent", validBuild), []);
    assert.deepEqual(packageBuildViolations("multi-step", {
        ...validBuild,
        scripts: {
            ...validBuild.scripts,
            build: "npm run build:clean && npm run build:dist && npm run build:assets",
        },
    }), []);
    assert.deepEqual(packageBuildViolations("stale", {
        files: ["dist/**/*"],
        scripts: {
            "build:dist": "rm -rf dist && tsc -p tsconfig.build.json",
            build: "npm run build:dist",
            prepack: "npm run build:dist",
        },
    }), [
        "stale: build:clean must be exactly `rm -rf dist`",
        "stale: build must begin with `npm run build:clean && `",
        "stale: build:dist must emit only; build:clean owns deletion",
        "stale: prepack must invoke the complete public build",
    ]);
});

const packedFiles = ["package.json", "dist/index.js", "dist/index.d.ts", "dist/Materializer.js", "dist/Materializer.d.ts", "README.md"];

test("{§packed-projection} published manifest projection strips plurnk-dev and verifies every exported target", () => {
    const { manifest, violations } = projectManifest({
        name: "@plurnk/example",
        exports: {
            ".": { [DEV_CONDITION]: "./src/index.ts", types: "./dist/index.d.ts", default: "./dist/index.js" },
            "./materializer": { [DEV_CONDITION]: "./src/Materializer.ts", types: "./dist/Materializer.d.ts", default: "./dist/Materializer.js" },
            "./package.json": "./package.json",
        },
    }, packedFiles);
    assert.deepEqual(violations, []);
    assert.deepEqual(manifest.exports, {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./materializer": { types: "./dist/Materializer.d.ts", default: "./dist/Materializer.js" },
        "./package.json": "./package.json",
    });
    assert.equal(JSON.stringify(manifest).includes(DEV_CONDITION), false);

    assert.deepEqual(projectManifest({
        name: "@plurnk/example",
        exports: {
            ".": { types: "./dist/index.d.ts", default: "./dist/missing.js" },
            "./docs": "./docs/guide.md",
        },
    }, packedFiles).violations, [
        'exports["."].default -> ./dist/missing.js: the tarball does not ship it',
        'exports["./docs"] -> ./docs/guide.md: the tarball does not ship it',
    ]);

    const docs = { name: "@plurnk/docs", exports: { "./docs/*.md": "./docs/*.md", "./skills/*": "./skills/*" } };
    assert.deepEqual(projectManifest(docs, [...packedFiles, "docs/guide.md", "skills/plurnk/SKILL.md"]).violations, []);
    assert.deepEqual(projectManifest(docs, packedFiles).violations, [
        'exports["./docs/*.md"] -> ./docs/*.md: the tarball does not ship it',
        'exports["./skills/*"] -> ./skills/*: the tarball does not ship it',
    ]);

    const plain = { name: "@plurnk/plain", exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } } };
    assert.deepEqual(projectManifest(plain, packedFiles), { manifest: plain, violations: [] });
    const bare = { name: "@plurnk/bare", main: "./dist/index.js" };
    assert.deepEqual(projectManifest(bare, packedFiles), { manifest: bare, violations: [] });
    assert.deepEqual(projectManifest({ name: "@plurnk/string", exports: "./dist/index.js" }, packedFiles).manifest.exports, "./dist/index.js");
});

test("{§packed-projection} package artifact projection requires runtime-loaded files and teaching assets and refuses test helpers", async () => {
    assert.deepEqual(packageArtifactViolations("plurnk-aliases", ["dist/index.js"]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-models", ["dist/index.js", "dist/catalog.json", "dist/providers.json"]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-models", ["dist/index.js"]), [
        "plurnk-models: required runtime artifact is absent: dist/catalog.json",
        "plurnk-models: required runtime artifact is absent: dist/providers.json",
    ]);
    assert.deepEqual(packageArtifactViolations("plurnk-mcp", ["dist/client.js", "dist/mcp-watchdog.mjs"]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-mcp", ["dist/client.js"]), [
        "plurnk-mcp: required runtime artifact is absent: dist/mcp-watchdog.mjs",
    ]);
    assert.deepEqual(packageArtifactViolations("plurnk-core", [
        "dist/core/content_weight.js",
        "dist/launch/Launch.js",
        "dist/evidence/EvidenceReader.js",
        "dist/evidence/digest.sql",
        "INSTALL.md",
        "plurnk.service",
        "plurnk.nginx.conf",
        "docs/copy-move.md",
        "dist/man/plurnk-service.1",
        "dist/completions/plurnk-service.bash",
        "dist/completions/_plurnk-service",
        "dist/completions/plurnk-service.fish",
        "dist/index.js",
    ]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-core", [
        "dist/core/resource-state.js",
        "dist/core/resource-state.sql",
        "dist/core/zero-pin.d.ts",
    ]), [
        "plurnk-core: required runtime artifact is absent: dist/core/content_weight.js",
        "plurnk-core: required runtime artifact is absent: dist/launch/Launch.js",
        "plurnk-core: required runtime artifact is absent: dist/evidence/EvidenceReader.js",
        "plurnk-core: required runtime artifact is absent: dist/evidence/digest.sql",
        "plurnk-core: required runtime artifact is absent: INSTALL.md",
        "plurnk-core: required runtime artifact is absent: plurnk.service",
        "plurnk-core: required runtime artifact is absent: plurnk.nginx.conf",
        "plurnk-core: required runtime artifact is absent: docs/copy-move.md",
        "plurnk-core: required runtime artifact is absent: dist/man/plurnk-service.1",
        "plurnk-core: required runtime artifact is absent: dist/completions/plurnk-service.bash",
        "plurnk-core: required runtime artifact is absent: dist/completions/_plurnk-service",
        "plurnk-core: required runtime artifact is absent: dist/completions/plurnk-service.fish",
        "plurnk-core: test-only artifact leaked into package: dist/core/resource-state.js",
        "plurnk-core: test-only artifact leaked into package: dist/core/resource-state.sql",
        "plurnk-core: test-only artifact leaked into package: dist/core/zero-pin.d.ts",
    ]);
    assert.deepEqual(packageArtifactViolations("plurnk-digest", ["dist/index.js", "dist/share.sql"]), []);
    assert.deepEqual(packageArtifactViolations("plurnk-digest", ["dist/index.js"]), [
        "plurnk-digest: required runtime artifact is absent: dist/share.sql",
    ]);
    assert.deepEqual(packageArtifactViolations("plurnk-mimetypes-application-pdf", [
        "dist/buildPdf.js", "dist/buildPdf.d.ts", "dist/index.js",
    ]), [
        "plurnk-mimetypes-application-pdf: test-only artifact leaked into package: dist/buildPdf.d.ts",
        "plurnk-mimetypes-application-pdf: test-only artifact leaked into package: dist/buildPdf.js",
    ]);
    for (const [owner, paths] of [
        ["plurnk-meta", ["skills/plurnk/SKILL.md", "skills/plurnk/references/extensibility.md", "docs/session.md", "docs/pattern.md", "docs/delegation.md"]],
        ["plurnk-skills", ["docs/skills.md"]],
        ["plurnk-providers", ["docs/models.md"]],
    ]) {
        assert.deepEqual(packageArtifactViolations(owner, paths), []);
        for (const p of paths) {
            assert.deepEqual(packageArtifactViolations(owner, paths.filter((candidate) => candidate !== p)), [
                `${owner}: required runtime artifact is absent: ${p}`,
            ]);
        }
    }
});

test("{§mimetype-query-assets} packed MIME query assets are complete and load from the packed archive", async () => {
    const workspace = fileURLToPath(new URL("../plurnk-mimetypes/", import.meta.url));
    const assets = (await readdir(join(workspace, "queries"))).filter((name) => name.endsWith(".scm")).map((name) => `queries/${name}`);
    assert.ok(assets.length > 0);
    assert.deepEqual(packageArtifactViolations("plurnk-mimetypes", assets), []);
    for (const asset of assets) {
        assert.deepEqual(
            packageArtifactViolations("plurnk-mimetypes", assets.filter((p) => p !== asset)),
            [`plurnk-mimetypes: required runtime artifact is absent: ${asset}`],
        );
    }

    const directory = await mkdtemp(join(tmpdir(), "plurnk-query-assets-"));
    try {
        const { stdout } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], { cwd: workspace });
        const records = packRecords(stdout);
        assert.equal(records.length, 1);
        const [packed] = records;
        assert.deepEqual(packageArtifactViolations("plurnk-mimetypes", packed.files.map(({ path: p }) => p)), []);
        await run("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
        const packedRoot = join(directory, "package");
        const { loadRefsQuery } = await import(pathToFileURL(join(packedRoot, "dist/treesitter/reference-query.js")).href);
        const scmFiles = (await readdir(join(workspace, "queries"))).filter((name) => name.endsWith(".scm"));
        for (const file of scmFiles) {
            assert.equal(await loadRefsQuery(file.slice(0, -4)), await readFile(join(workspace, "queries", file), "utf8"), file);
        }
        await rm(join(packedRoot, "queries", "python.scm"));
        await assert.rejects(loadRefsQuery("python"), { code: "ENOENT" });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

const typeAuditFixture = async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "plurnk-package-types-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packages = {
        "code package": { name: "@example/code", files: ["dist/**/*"] },
        meta: { name: "@plurnk/plurnk-meta", files: ["dist/**/*", "POLICY.md", "recap.md"] },
        assets: { name: "@example/assets", files: ["assets/**/*"] },
        private: { name: "@example/private", private: true, files: ["dist/**/*"] },
    };
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: Object.keys(packages) }));
    for (const [directory, manifest] of Object.entries(packages)) {
        await mkdir(path.join(root, directory));
        await writeFile(path.join(root, directory, "package.json"), JSON.stringify(manifest));
    }
    return root;
};

test("{§packed-projection} type audit checks packed public code with explicit profile, selections, and failure reporting", async (t) => {
    const root = await typeAuditFixture(t);
    const calls = [];
    const count = await checkPackageTypes(root, {
        run: async (command, args, cwd) => { calls.push({ command, args, cwd }); return { code: 0, signal: null }; },
        report: () => {},
    });
    assert.equal(count, 3);
    assert.deepEqual(calls, [
        { command: "attw", cwd: root, args: ["--pack", "code package", "--profile", "esm-only", "--format", "table", "--no-color"] },
        { command: "attw", cwd: root, args: ["--pack", "meta", "--profile", "esm-only", "--format", "table", "--no-color", "--exclude-entrypoints", "./POLICY.md", "./recap.md"] },
        { command: "attw", cwd: root, args: ["--pack", "assets", "--profile", "esm-only", "--format", "table", "--no-color"] },
    ]);

    const selCalls = [];
    const options = { run: async (...args) => { selCalls.push(args); return { code: 0, signal: null }; }, report: () => {} };
    assert.equal(await checkPackageTypes(root, { ...options, only: "code package" }), 1);
    assert.equal(await checkPackageTypes(root, { ...options, only: ["code package", "assets"] }), 2);
    await assert.rejects(checkPackageTypes(root, { ...options, only: "../elsewhere" }), /Unknown workspace: \.\.\/elsewhere/);
    await assert.rejects(checkPackageTypes(root, { ...options, only: "private" }), /No public package selected/);

    let failCalls = 0;
    await assert.rejects(checkPackageTypes(root, {
        run: async () => ++failCalls === 1 ? { code: 1, signal: null } : { code: null, signal: "SIGTERM" },
        report: () => {},
    }), /code package: exit 1[\s\S]*meta: signal SIGTERM/);
    assert.equal(failCalls, 3);

    await mkdir(path.join(root, "broken", "dist"), { recursive: true });
    await writeFile(path.join(root, "broken", "dist", "index.js"), "export const x = 1;\n");
    await writeFile(path.join(root, "broken", "dist", "other.d.ts"), "export declare const y: number;\n");
    await writeFile(path.join(root, "broken", "package.json"), JSON.stringify({
        name: "@example/broken",
        version: "1.0.0",
        type: "module",
        exports: { ".": { types: "./dist/missing.d.ts", default: "./dist/index.js" } },
        files: ["dist/**/*"],
    }));
    await writeFile(path.join(root, "package.json"), JSON.stringify({ workspaces: ["broken"] }));
    await assert.rejects(checkPackageTypes(root, { only: "broken", report: () => {} }), /ATTW failed for 1 package\(s\):\nbroken: exit 1/);
});

const firstRecord = { name: "@plurnk/example", version: "1.0.0", filename: "plurnk-example-1.0.0.tgz", files: [] };
const secondRecord = { name: "other", version: "2.0.0", filename: "other-2.0.0.tgz", files: [] };

test("{§release-candidate-graph} npm pack and view JSON readers normalize valid records and reject empty or ambiguous responses", () => {
    for (const records of [[firstRecord], [firstRecord, secondRecord]]) {
        assert.deepEqual(packRecords(JSON.stringify(records)), records);
        assert.deepEqual(packRecords(JSON.stringify(Object.fromEntries(records.map((record) => [record.name, record])))), records);
    }
    assert.throws(() => packRecords("not JSON"), SyntaxError);
    for (const value of [null, 42, "artifact.tgz", [], {}, [null], [{}], { error: { code: "E404" } }, [{ ...firstRecord, filename: "" }]]) {
        assert.throws(() => packRecords(JSON.stringify(value)), /npm pack returned no valid artifacts/);
    }
    assert.deepEqual(viewManifest(JSON.stringify(firstRecord)), firstRecord);
    assert.deepEqual(viewManifest(JSON.stringify([firstRecord])), firstRecord);
    assert.throws(() => viewManifest("not JSON"), SyntaxError);
    for (const value of [null, 42, "manifest", [], [firstRecord, secondRecord], [null]]) {
        assert.throws(() => viewManifest(JSON.stringify(value)), /npm view returned no unique package manifest/);
    }
});
