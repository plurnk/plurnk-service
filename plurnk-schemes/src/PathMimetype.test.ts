// Unit tests for PathMimetype. Cases requiring discovered handler
// packages (`.json` → `application/json`, etc.) live in plurnk-service's
// intg suite where the production handler set is installed.

import test from "node:test";
import { strict as assert } from "node:assert";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import PathMimetype from "./PathMimetype.ts";

const mimetypes = new Mimetypes();
await mimetypes.ready();

test("{§path-extension-mimetype} resolve: no extension → scheme default", async () => {
    assert.equal(await PathMimetype.resolve("users", "text/markdown", mimetypes), "text/markdown");
    assert.equal(await PathMimetype.resolve("notes", "text/plain", mimetypes), "text/plain");
});

test("{§path-extension-mimetype} resolve: leading-dot file is not an extension", async () => {
    // `.env` is a filename, not an extension; falls back to scheme default.
    assert.equal(await PathMimetype.resolve(".env", "text/markdown", mimetypes), "text/markdown");
});

test("{§path-extension-mimetype} resolve: unknown extension → scheme default", async () => {
    // .xyz isn't a registered mimetype handler; detect returns null;
    // resolver falls back to scheme default.
    const result = await PathMimetype.resolve("data.xyz", "text/markdown", mimetypes);
    assert.equal(result, "text/markdown");
});
