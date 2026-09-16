import test from "node:test";
import assert from "node:assert/strict";
import { MimetypeInputLimitError } from "@plurnk/plurnk-mimetypes";
import DbProjectionCaps from "./DbProjectionCaps.ts";
import type { PlurnkSchemeContext } from "../scheme-types.ts";

const context = (content: string | undefined): PlurnkSchemeContext => ({
    mimetypes: {
        async projectReadable({ hint }: { hint: string }) {
            return content === undefined ? null : {
                content,
                sourceMimetype: hint,
                projectionIdentity: hint === "text/html" ? "html-projection-v1" : "pdf-projection-v1",
            };
        },
        async projectionIdentity(mimetype: string) {
            return `${mimetype}-identity`;
        },
        async classify(mimetype: string) {
            return { binary: mimetype === "text/x-binary", source: "handler" };
        },
        async process() {
            return { mimetype: "text/x-go", ok: true, totalLines: 2, parseIssues: 3 };
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

test("{§scheme-projection} binary retains the bounded source beside an optional readable projection", async () => {
    async function* bytes() {
        yield Uint8Array.of(1, 2, 3);
    }
    assert.deepEqual(
        await new DbProjectionCaps(context("PDF text")).binary(bytes(), "application/pdf"),
        {
            bytes: Uint8Array.of(1, 2, 3),
            projectionIdentity: "pdf-projection-v1",
            readable: {
                content: "PDF text",
                mimetype: "text/markdown",
                sourceMimetype: "application/pdf",
                projectionIdentity: "pdf-projection-v1",
            },
        },
    );
    assert.deepEqual(await new DbProjectionCaps(context(undefined)).binary(bytes(), "application/octet-stream"), {
        bytes: Uint8Array.of(1, 2, 3), readable: null, projectionIdentity: "application/octet-stream-identity",
    });
});

test("projection identity delegates to the configured mimetype family", async () => {
    assert.equal(
        await new DbProjectionCaps(context("")).identity("application/pdf"),
        "application/pdf-identity",
    );
});

test("binary classification delegates to installed handler declarations", async () => {
    const projection = new DbProjectionCaps(context(""));
    assert.equal(await projection.isBinary("text/x-binary"), true);
    assert.equal(await projection.isBinary("application/json"), false);
});

test("{§mimetype-binary-input} source acquisition enforces the ceiling even without a readable handler", async (t) => {
    const maximum = process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES;
    process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = "3";
    t.after(() => { if (maximum === undefined) delete process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES; else process.env.PLURNK_MIMETYPES_BINARY_INPUT_MAX_BYTES = maximum; });
    let closed = false;
    async function* chunks() {
        try { yield Uint8Array.of(1, 2, 3); yield Uint8Array.of(4); }
        finally { closed = true; }
    }
    await assert.rejects(new DbProjectionCaps(context(undefined)).binary(chunks(), "application/octet-stream"), (error) => {
        assert.ok(error instanceof MimetypeInputLimitError);
        assert.equal(error.maximumBytes, 3);
        assert.equal(error.observedBytes, 4);
        return true;
    });
    assert.equal(closed, true);
});

test("parser-recovery inspection requests metadata without structural channels", async () => {
    let options: unknown;
    const ctx = {
        mimetypes: {
            async process(_input: unknown, value: unknown) {
                options = value;
                return { mimetype: "text/x-go", ok: true, totalLines: 2, parseIssues: 3 };
            },
        },
    } as unknown as PlurnkSchemeContext;
    assert.equal(await new DbProjectionCaps(ctx).parseIssues("package p\nfunc broken(", "text/x-go"), 3);
    assert.deepEqual(options, { channels: [], parseIssues: true });
});

test("parser-recovery inspection distinguishes clean content from unavailable evidence", async () => {
    const clean = {
        mimetypes: {
            async process() {
                return { mimetype: "text/x-go", ok: true, totalLines: 2 };
            },
        },
    } as unknown as PlurnkSchemeContext;
    assert.equal(await new DbProjectionCaps(clean).parseIssues("package p", "text/x-go"), 0);

    const missingGrammar = {
        mimetypes: {
            async process() {
                return {
                    mimetype: "text/x-go",
                    ok: true,
                    totalLines: 2,
                    grammarMissing: "@plurnk/tree-sitter-go",
                };
            },
        },
    } as unknown as PlurnkSchemeContext;
    assert.equal(await new DbProjectionCaps(missingGrammar).parseIssues("package p", "text/x-go"), undefined);
});

test("parser-recovery inspection surfaces tooling failure without failing the mutation path", async () => {
    const notices: unknown[] = [];
    const ctx = {
        mimetypes: {
            async process() { throw new Error("parser exploded"); },
        },
        pushNotice(notice: unknown) { notices.push(notice); },
    } as unknown as PlurnkSchemeContext;
    assert.equal(await new DbProjectionCaps(ctx).parseIssues("broken", "text/x-go"), undefined);
    assert.deepEqual(notices, [{
        source: "engine:mimetype",
        kind: "parse_issues_unavailable",
        level: "warn",
        message: "Parser recovery evidence unavailable for text/x-go: parser exploded",
    }]);
});

test("a typed mimetype input ceiling failure crosses the capability unchanged", async () => {
    const cause = new MimetypeInputLimitError({
        mimetype: "application/pdf",
        maximumBytes: 3,
        observedBytes: 4,
    });
    const ctx = {
        mimetypes: {
            async projectReadable() { throw cause; },
        },
    } as unknown as PlurnkSchemeContext;
    async function* bytes() {
        yield Uint8Array.of(1, 2, 3, 4);
    }

    await assert.rejects(
        () => new DbProjectionCaps(ctx).binary(bytes(), "application/pdf"),
        (error: unknown) => error === cause,
    );
});
