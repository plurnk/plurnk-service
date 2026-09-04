import test from "node:test";
import assert from "node:assert/strict";
import { acceptedKinds, attachmentTeaching } from "./attachments.ts";

test("{§attachment-teaching} the Attachments section names exactly the kinds the route accepts and the daemon can attach", () => {
    const installed = new Set(["image/png", "application/pdf"]);
    assert.equal(attachmentTeaching(new Set(), installed), "", "a blind route gets no section");
    assert.equal(attachmentTeaching(new Set(["audio", "video"]), installed), "", "a modality without a handler teaches nothing");
    assert.equal(attachmentTeaching(new Set(["image", "pdf"]), new Set()), "", "an uninstalled handler is not advertised");
    const image = attachmentTeaching(new Set(["image"]), installed);
    assert.match(image, /^```example\n### READ0 \(assets\/logo\.png\)/);
    assert.doesNotMatch(image, /contract\.pdf/);
    const imageOnly = attachmentTeaching(new Set(["image", "pdf"]), new Set(["image/png"]));
    assert.match(imageOnly, /logo\.png/);
    assert.doesNotMatch(imageOnly, /contract\.pdf/);
    const both = attachmentTeaching(new Set(["image", "pdf", "video"]), installed);
    assert.match(both, /logo\.png[\s\S]*contract\.pdf[\s\S]*```$/);
});

test("{§packet-attachment-parts} accepted kinds follow the route's modalities in table order", () => {
    assert.deepEqual(acceptedKinds(new Set()), []);
    assert.deepEqual(acceptedKinds(new Set(["pdf"])), ["pdf"]);
    assert.deepEqual(acceptedKinds(new Set(["pdf", "image", "audio"])), ["image", "pdf"]);
});
