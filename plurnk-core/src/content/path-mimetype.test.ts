// Unit tests for path-mimetype. Cases requiring discovered handler
// packages (`.json` → `application/json`, etc.) live in plurnk-service's
// intg suite where the production handler set is installed.

import test from "node:test";
import { strict as assert } from "node:assert";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import PathMimetype from "./path-mimetype.ts";

const mimetypes = new Mimetypes();
await mimetypes.ready();

test("PathMimetype.resolveEntryMimetype: no extension → scheme default", async () => {
    assert.equal(await PathMimetype.resolveEntryMimetype("users", "text/markdown", mimetypes), "text/markdown");
    assert.equal(await PathMimetype.resolveEntryMimetype("notes", "text/plain", mimetypes), "text/plain");
});

test("PathMimetype.resolveEntryMimetype: leading-dot file is not an extension", async () => {
    // `.env` is a filename, not an extension; falls back to scheme default.
    assert.equal(await PathMimetype.resolveEntryMimetype(".env", "text/markdown", mimetypes), "text/markdown");
});

test("PathMimetype.resolveEntryMimetype: no Mimetypes service → scheme default", async () => {
    // Defensive: if the consumer doesn't pass a Mimetypes instance,
    // the resolver can't run detection — fall back to scheme default.
    assert.equal(await PathMimetype.resolveEntryMimetype("users.json", "text/markdown", undefined), "text/markdown");
});

test("PathMimetype.resolveEntryMimetype: unknown extension → scheme default", async () => {
    // .xyz isn't a registered mimetype handler; detect returns null;
    // resolver falls back to scheme default.
    const result = await PathMimetype.resolveEntryMimetype("data.xyz", "text/markdown", mimetypes);
    assert.equal(result, "text/markdown");
});
