import test from "node:test";
import assert from "node:assert/strict";
import { acceptedKinds, attachmentTeaching } from "./attachments.ts";

test("{§attachment-teaching} the Attachments section names exactly the kinds the route accepts and the daemon can attach", () => {
    assert.equal(attachmentTeaching(new Set()), "", "a blind route gets no section");
    assert.equal(attachmentTeaching(new Set(["audio", "video"])), "", "a modality without a handler teaches nothing");
    const image = attachmentTeaching(new Set(["image"]));
    assert.match(image, /^```example\n### READ0 \(assets\/logo\.png\)/);
    assert.doesNotMatch(image, /contract\.pdf/);
    const both = attachmentTeaching(new Set(["image", "pdf", "video"]));
    assert.match(both, /logo\.png[\s\S]*contract\.pdf[\s\S]*```$/);
});

test("{§packet-attachment-parts} accepted kinds follow the route's modalities in table order", () => {
    assert.deepEqual(acceptedKinds(new Set()), []);
    assert.deepEqual(acceptedKinds(new Set(["pdf"])), ["pdf"]);
    assert.deepEqual(acceptedKinds(new Set(["pdf", "image", "audio"])), ["image", "pdf"]);
});
