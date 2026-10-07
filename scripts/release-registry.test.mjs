import assert from "node:assert/strict";
import test from "node:test";
import { assertPublishedArtifact, registryPackage } from "./release-registry.mjs";

const name = "@plurnk/example";
const version = "2.1.3";
const candidate = { name, version, integrity: "sha512-tested", commit: "a".repeat(40) };
const error = (code) => Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) });

test("{§release-candidate-graph} registry queries the exact version even when it is not latest", async () => {
    const result = await registryPackage(name, version, async (spec) => {
        assert.equal(spec, `${name}@${version}`);
        return JSON.stringify({ name, version, "dist-tags": { latest: "3.0.0" } });
    });
    assert.equal(result.version, version);
});

test("{§release-candidate-graph} only explicit missing-version evidence permits publication", async () => {
    assert.equal(await registryPackage(name, version, async () => { throw error("E404"); }), undefined);
    for (const cause of [error("E401"), error("E500"), error("ETIMEDOUT"), new Error("connection lost")]) {
        await assert.rejects(registryPackage(name, version, async () => { throw cause; }), (result) => {
            assert.equal(result.cause, cause);
            assert.match(result.message, /registry lookup failed/);
            return true;
        });
    }
});

test("{§release-candidate-graph} malformed and mismatched registry responses fail closed", async () => {
    await assert.rejects(registryPackage(name, version, async () => "not json"), SyntaxError);
    await assert.rejects(registryPackage(name, version, async () => JSON.stringify({ name, version: "3.0.0" })), /different identity/);
});

test("{§release-candidate-graph} resuming an immutable version requires the same archive and source", () => {
    const published = { name, version, dist: { integrity: candidate.integrity }, gitHead: candidate.commit };
    assert.doesNotThrow(() => assertPublishedArtifact(candidate, published));
    for (const mismatch of [
        { version: "2.1.4" }, { name: "different" }, { dist: { integrity: "sha512-different" } }, { gitHead: "b".repeat(40) },
    ]) assert.throws(() => assertPublishedArtifact(candidate, { ...published, ...mismatch }), /differs/);
});
