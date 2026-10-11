import assert from "node:assert/strict";
import test from "node:test";
import { packRecords, viewManifest } from "./npm-json.mjs";

const first = { name: "@plurnk/example", version: "1.0.0", filename: "plurnk-example-1.0.0.tgz", files: [] };
const second = { name: "other", version: "2.0.0", filename: "other-2.0.0.tgz", files: [] };

test("{§release-candidate-graph}: npm pack arrays and package-keyed objects retain every artifact", () => {
    for (const records of [[first], [first, second]]) {
        assert.deepEqual(packRecords(JSON.stringify(records)), records);
        assert.deepEqual(packRecords(JSON.stringify(Object.fromEntries(records.map((record) => [record.name, record])))), records);
    }
});

test("{§release-candidate-graph}: invalid or empty npm pack responses cannot become artifact records", () => {
    assert.throws(() => packRecords("not JSON"), SyntaxError);
    for (const value of [null, 42, "artifact.tgz", [], {}, [null], [{}], { error: { code: "E404" } }, [{ ...first, filename: "" }]]) {
        assert.throws(() => packRecords(JSON.stringify(value)), /npm pack returned no valid artifacts/);
    }
});

test("{§release-candidate-graph}: npm view accepts one manifest, never an ambiguous version set", () => {
    assert.deepEqual(viewManifest(JSON.stringify(first)), first);
    assert.deepEqual(viewManifest(JSON.stringify([first])), first);
    assert.throws(() => viewManifest("not JSON"), SyntaxError);
    for (const value of [null, 42, "manifest", [], [first, second], [null]]) {
        assert.throws(() => viewManifest(JSON.stringify(value)), /npm view returned no unique package manifest/);
    }
});
