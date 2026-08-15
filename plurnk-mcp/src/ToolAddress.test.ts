import assert from "node:assert/strict";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-contracts";
import ToolAddress from "./ToolAddress.ts";

test("tool authorities preserve ordinary names and reversibly encode hostile names", () => {
    assert.equal(ToolAddress.render("gitea", "issue_read"), "gitea://issue_read/");
    const name = "Case/Tool_(one)%";
    const address = ToolAddress.render("gitea", name);
    assert.equal(address, "gitea://Case%2FTool_%28one%29%25/");
    const target = parsePath(address);
    assert.notEqual(target, null);
    assert.equal(ToolAddress.name(target!), name);
});

test("the literal wildcard is catalog syntax while an encoded star remains an exact tool", () => {
    const wildcard = parsePath("gitea://*/");
    const literal = parsePath("gitea://%2A/");
    assert.notEqual(wildcard, null);
    assert.notEqual(literal, null);
    assert.equal(ToolAddress.isCatalog(wildcard!), true);
    assert.equal(ToolAddress.isCatalog(literal!), false);
    assert.equal(ToolAddress.name(literal!), "*");
});

test("non-canonical percent spellings do not create aliases for one tool contract", () => {
    const encodedUnreserved = parsePath("gitea://%69ssue_read/");
    const lowercaseHex = parsePath("gitea://Case%2fTool/");
    assert.notEqual(encodedUnreserved, null);
    assert.notEqual(lowercaseHex, null);
    assert.equal(ToolAddress.name(encodedUnreserved!), null);
    assert.equal(ToolAddress.name(lowercaseHex!), null);
});
