import test from "node:test";
import assert from "node:assert/strict";
import { MimetypeInputLimitError } from "@plurnk/plurnk-mimetypes";
import DbProjectionCaps from "./DbProjectionCaps.ts";
import type { PlurnkSchemeContext } from "../scheme-types.ts";

const context = (content: string | undefined): PlurnkSchemeContext => ({
    mimetypes: {
        async projectReadable() {
            return content === undefined ? null : {
                content,
                sourceMimetype: "text/html",
                projectionIdentity: "html-projection-v1",
            };
        },
        async projectReadableStream() {
            return content === undefined ? null : {
                content,
                sourceMimetype: "application/pdf",
                projectionIdentity: "pdf-projection-v1",
            };
        },
        async projectionIdentity(mimetype: string) {
            return `${mimetype}-identity`;
        },
    },
} as unknown as PlurnkSchemeContext);

test("readable preserves a present empty projection and reserves null for absence", async () => {
    assert.deepEqual(
        await new DbProjectionCaps(context("")).readable("<div></div>", "text/html"),
        {
            content: "",
            mimetype: "text/markdown",
            sourceMimetype: "text/html",
            projectionIdentity: "html-projection-v1",
        },
    );
    assert.equal(
        await new DbProjectionCaps(context(undefined)).readable("<div></div>", "text/html"),
        null,
    );
});

test("readableBytes delegates one async byte source without widening the result", async () => {
    async function* bytes() {
        yield Uint8Array.of(1, 2, 3);
    }
    assert.deepEqual(
        await new DbProjectionCaps(context("PDF text")).readableBytes(bytes(), "application/pdf"),
        {
            content: "PDF text",
            mimetype: "text/markdown",
            sourceMimetype: "application/pdf",
            projectionIdentity: "pdf-projection-v1",
        },
    );
});

test("projection identity delegates to the configured mimetype family", async () => {
    assert.equal(
        await new DbProjectionCaps(context("")).identity("application/pdf"),
        "application/pdf-identity",
    );
});

test("a typed mimetype input ceiling failure crosses the capability unchanged", async () => {
    const cause = new MimetypeInputLimitError({
        mimetype: "application/pdf",
        maximumBytes: 3,
        observedBytes: 4,
    });
    const ctx = {
        mimetypes: {
            async projectReadableStream() { throw cause; },
        },
    } as unknown as PlurnkSchemeContext;
    async function* bytes() {
        yield Uint8Array.of(1, 2, 3, 4);
    }

    await assert.rejects(
        () => new DbProjectionCaps(ctx).readableBytes(bytes(), "application/pdf"),
        (error: unknown) => error === cause,
    );
});
