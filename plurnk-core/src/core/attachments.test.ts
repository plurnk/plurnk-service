import test from "node:test";
import assert from "node:assert/strict";
import { acceptedKinds } from "./attachments.ts";

test("{§packet-attachment-parts} accepted kinds follow the route's modalities in table order", () => {
    assert.deepEqual(acceptedKinds(new Set()), []);
    assert.deepEqual(acceptedKinds(new Set(["pdf"])), ["pdf"]);
    assert.deepEqual(acceptedKinds(new Set(["pdf", "image", "audio"])), ["image", "pdf"]);
});
