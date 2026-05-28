import test from "node:test";
import { strict as assert } from "node:assert";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { resolveEntryMimetype } from "./path-mimetype.ts";

// Mimetypes singleton loaded once (process-wide discovery is expensive).
const mimetypes = new Mimetypes({ tokenize: async (text: string) => text.length });
await mimetypes.ready();

test("resolveEntryMimetype: known extension → derived mimetype", async () => {
    assert.equal(await resolveEntryMimetype("users.json", "text/markdown", mimetypes), "application/json");
    assert.equal(await resolveEntryMimetype("config.yaml", "text/markdown", mimetypes), "application/yaml");
    assert.equal(await resolveEntryMimetype("README.md", "text/plain", mimetypes), "text/markdown");
});

test("resolveEntryMimetype: no extension → scheme default", async () => {
    assert.equal(await resolveEntryMimetype("users", "text/markdown", mimetypes), "text/markdown");
    assert.equal(await resolveEntryMimetype("notes", "text/plain", mimetypes), "text/plain");
});

test("resolveEntryMimetype: leading-dot file is not an extension", async () => {
    // `.env` is a filename, not an extension; falls back to scheme default.
    assert.equal(await resolveEntryMimetype(".env", "text/markdown", mimetypes), "text/markdown");
});

test("resolveEntryMimetype: extension wins over scheme default", async () => {
    // Even when scheme default is markdown, .json suffix routes to JSON.
    assert.equal(await resolveEntryMimetype("users.json", "text/markdown", mimetypes), "application/json");
});

test("resolveEntryMimetype: nested path segments — extension from the last segment", async () => {
    assert.equal(await resolveEntryMimetype("a/b/users.json", "text/markdown", mimetypes), "application/json");
    assert.equal(await resolveEntryMimetype("a.json/b", "text/markdown", mimetypes), "text/markdown");
});

test("resolveEntryMimetype: text/plain auto-normalizes to text/markdown (text primitive)", async () => {
    // If detect returns text/plain (e.g., for .txt), we normalize to text/markdown
    // per the text-primitive rule. Confirms the normalization applies through
    // this resolver.
    const result = await resolveEntryMimetype("notes.txt", "text/markdown", mimetypes);
    assert.equal(result, "text/markdown");  // .txt → text/plain → normalized
});

test("resolveEntryMimetype: no Mimetypes service → scheme default", async () => {
    // Defensive: if the consumer doesn't pass a Mimetypes instance,
    // the resolver can't run detection — fall back to scheme default.
    assert.equal(await resolveEntryMimetype("users.json", "text/markdown", undefined), "text/markdown");
});

test("resolveEntryMimetype: unknown extension → scheme default", async () => {
    // .xyz isn't a registered mimetype handler; detect returns null;
    // resolver falls back to scheme default.
    const result = await resolveEntryMimetype("data.xyz", "text/markdown", mimetypes);
    assert.equal(result, "text/markdown");
});
