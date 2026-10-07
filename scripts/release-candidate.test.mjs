import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { packCandidate, readCandidate, writeJson } from "./release-candidate.mjs";
import { verifyConsumer } from "./release-consumer.mjs";

const fixture = async (t, manifests) => {
    const directory = await mkdtemp(path.join(tmpdir(), "plurnk-qualified-release-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const records = [];
    for (const manifest of manifests) {
        const cwd = path.join(directory, manifest.name);
        await mkdir(cwd, { recursive: true });
        await writeJson(path.join(cwd, "package.json"), { type: "module", ...manifest });
        await writeFile(path.join(cwd, "index.js"), "export const value = 42;\n");
        records.push(await packCandidate({
            cwd, root: cwd, repo: "example", packageFile: "package.json", manifest,
            commit: "a".repeat(40),
        }, directory));
    }
    await writeJson(path.join(directory, "release.json"), { qualified: "2026-10-07T00:00:00Z", packages: records });
    return { directory, records };
};

test("{§release-candidate-graph} qualification installs independent archives and retains the resolved composition", async (t) => {
    const { directory, records } = await fixture(t, [
        { name: "release-fixture-contract", version: "3.2.0" },
        { name: "release-fixture-service", version: "2.4.0", dependencies: { "release-fixture-contract": "^3.0.0" } },
        { name: "release-fixture-client", version: "4.1.2", optionalDependencies: { "release-fixture-service": "^2.0.0" } },
    ]);
    const evidence = path.join(directory, "installed-lock.json");
    await verifyConsumer(records, { directory, evidence });
    const lock = JSON.parse(await readFile(evidence, "utf8"));
    for (const { name, version, integrity } of records) {
        assert.equal(lock.packages[`node_modules/${name}`].version, version);
        assert.equal(lock.packages[`node_modules/${name}`].integrity, integrity);
    }
    assert.deepEqual((await readCandidate(directory)).packages, records);
});

test("{§release-candidate-graph} qualified archives carry the verified source and only shipped export conditions", async (t) => {
    const { directory, records } = await fixture(t, [{
        name: "release-fixture", version: "2.0.0",
        exports: { ".": { "plurnk-dev": "./missing.ts", default: "./index.js" } },
    }]);
    const [record] = (await readCandidate(directory)).packages;
    assert.deepEqual(record.manifest.exports, { ".": { default: "./index.js" } });
    assert.equal(record.manifest.gitHead, records[0].commit);
});

test("{§release-candidate-graph} a changed archive cannot resume publication", async (t) => {
    const { directory, records } = await fixture(t, [{ name: "release-fixture", version: "2.0.0" }]);
    await appendFile(path.join(directory, records[0].archive), "changed");
    await assert.rejects(readCandidate(directory), /qualified archive changed/);
});

test("{§release-candidate-graph} an edited manifest record cannot substitute an untested dependency", async (t) => {
    const { directory, records } = await fixture(t, [{ name: "release-fixture", version: "2.0.0" }]);
    records[0].manifest.dependencies = { unexpected: "*" };
    await writeFile(path.join(directory, "release.json"), JSON.stringify({ qualified: "yes", packages: records }));
    await assert.rejects(readCandidate(directory), /qualified manifest changed/);
});

test("{§release-candidate-graph} incomplete qualification cannot publish", async (t) => {
    const { directory, records } = await fixture(t, [{ name: "release-fixture", version: "2.0.0" }]);
    await writeFile(path.join(directory, "release.json"), JSON.stringify({ packages: records }));
    await assert.rejects(readCandidate(directory), /not completed qualification/);
});
