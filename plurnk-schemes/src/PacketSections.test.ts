import assert from "node:assert/strict";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import EntryCoordinates from "./EntryCoordinates.ts";
import MessageScheme from "./MessageScheme.ts";
import PacketSections, { type PacketSectionDraft } from "./PacketSections.ts";
import { WebMaterializationError } from "./WebMaterialization.ts";
import type { SchemeHandler } from "./handler.ts";
import { schemeCtx } from "../test/scheme-ctx.ts";

// @ts-expect-error Scheme handlers cannot replace core-owned READ projection.
const invalidReadHandler: SchemeHandler = { async read() { return { status: 200 }; } };
void invalidReadHandler;

const section = (over: Partial<PacketSectionDraft> = {}): PacketSectionDraft =>
    ({ name: "x", slot: "system", header: null, content: "", ...over });

test("{§network-address} PacketSections: exact valid drafts preserve their list", () => {
    const drafts = [section({ name: "definition" }), section({ name: "prompt", slot: "user" }), section({ name: "authored", slot: "assistant" })];
    assert.equal(PacketSections.assertDrafts(drafts), drafts);
});

test("{§network-address} PacketSections: malformed draft lists fail with their exact location", () => {
    assert.throws(() => PacketSections.assertDrafts(null), /packet section drafts must be an array/);
    assert.throws(
        () => PacketSections.assertDrafts([null]),
        /packet section drafts\[0\] must be an object/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "", slot: "user", header: null, content: "" }]),
        /packet section drafts\[0\]\.name must be a non-empty string/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "tool", header: null, content: "" }]),
        /packet section drafts\[0\]\.slot must be system, user or assistant/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "user", header: 12, content: "" }]),
        /packet section drafts\[0\]\.header must be a string or null/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "user", header: null, content: 12 }]),
        /packet section drafts\[0\]\.content must be a string/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ name: "x", slot: "user", header: null }]),
        /packet section drafts\[0\] is missing field 'content'/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([{ ...section(), tokens: 0 }]),
        /packet section drafts\[0\] has unexpected field 'tokens'/,
    );
    assert.throws(
        () => PacketSections.assertDrafts([section(), section()]),
        /packet section drafts has duplicate section name 'x'/,
    );
});

test("{§network-address} EntryCoordinates resolves local, folded-authority, and resource-authority paths", () => {
    const local = parsePath("notes/file\\(1\\).md");
    assert.ok(local);
    assert.deepEqual(EntryCoordinates.resolve(local, "namespace"), { authority: "", pathname: "notes/file(1).md" });

    const url = parsePath("https://example.com:8443/dir/item\\(1\\)?a=1");
    assert.ok(url);
    assert.deepEqual(EntryCoordinates.resolve(url, "resource"), {
        authority: "example.com:8443",
        pathname: "/dir/item(1)?a=1",
    });
    assert.deepEqual(EntryCoordinates.resolve(url, "namespace"), {
        authority: "",
        pathname: "/example.com/dir/item(1)",
    });
});

test("{§message-source-scheme} MessageScheme resolves read addresses, refuses writes, and delegates prepare/send", async () => {
    const scheme = new MessageScheme("session");
    assert.equal(scheme.manifest.name, "session");
    assert.equal(scheme.manifest.authority, "resource");

    const prepared: Array<string | undefined> = [];
    let replied = false;
    const ctx = schemeCtx({
        messages: {
            prepare: async (target) => {
                prepared.push(target);
                return { status: 200 };
            },
            reply: async () => {
                replied = true;
                return { status: 200 };
            },
        },
    });

    const target = parsePath("session://alice/msg\\(1\\)?reply=1");
    assert.ok(target && target.kind === "url");
    assert.deepEqual(await scheme.resolveEntryAddress(target, ctx, "read"), {
        authority: "alice",
        pathname: "/msg(1)?reply=1",
    });

    const local = parsePath("local.md");
    assert.ok(local);
    assert.equal(await scheme.resolveEntryAddress(local, ctx, "read"), null);

    const writeRefusal = await scheme.resolveEntryAddress(target, ctx, "write");
    assert.ok(writeRefusal && "status" in writeRefusal);
    assert.equal(writeRefusal.status, 405);

    const position = { line: 1, column: 1 };
    assert.deepEqual(await scheme.prepareRepresentation({ target, metadata: null, authority: "alice", pathname: "/msg(1)" }, ctx), { status: 200 });
    assert.deepEqual(await scheme.prepareFind({ op: "FIND", target, lineMarker: null, matcher: null, metadata: null, aside: null, body: null, position }, ctx), { status: 200 });
    assert.deepEqual(prepared, [target.raw, undefined]);

    assert.deepEqual(await scheme.send({ op: "SEND", target, lineMarker: null, metadata: null, aside: null, body: null, position }, ctx), { status: 200 });
    assert.equal(replied, true);
});

test("{§scheme-operation-dispatch} WebMaterializationError records the failing mimetype and cause", () => {
    const cause = new Error("bad html");
    const err = new WebMaterializationError("text/html", cause);
    assert.equal(err.name, "WebMaterializationError");
    assert.equal(err.stage, "projection");
    assert.equal(err.mimetype, "text/html");
    assert.equal(err.cause, cause);
    assert.match(err.message, /text\/html/);
});
