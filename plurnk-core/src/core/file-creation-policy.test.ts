import test from "node:test";
import assert from "node:assert/strict";
import FileCreationPolicy from "./file-creation-policy.ts";

test("{§file-create-scope}: the ordered scope composes by the most restrictive value", () => {
    assert.equal(FileCreationPolicy.effective("namespace", "root"), "root");
    assert.equal(FileCreationPolicy.effective("root", "namespace"), "root");
    assert.equal(FileCreationPolicy.effective("namespace", "none"), "none");
    assert.equal(FileCreationPolicy.effective("root", null), "root");
    assert.equal(FileCreationPolicy.admits("none", false), false);
    assert.equal(FileCreationPolicy.admits("root", false), true);
    assert.equal(FileCreationPolicy.admits("root", true), false);
    assert.equal(FileCreationPolicy.admits("namespace", true), true);
});

test("{§operator-config-file-create-scope}: service configuration is a closed enum", () => {
    assert.equal(FileCreationPolicy.serviceScope({ PLURNK_SERVICE_FILE_CREATE_SCOPE: "root" }), "root");
    assert.throws(
        () => FileCreationPolicy.serviceScope({ PLURNK_SERVICE_FILE_CREATE_SCOPE: "yes" }),
        /must be one of none, root, namespace/,
    );
    assert.throws(
        () => FileCreationPolicy.serviceScope({}),
        /PLURNK_SERVICE_FILE_CREATE_SCOPE/,
    );
});
