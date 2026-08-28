import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type ReadStatement } from "@plurnk/plurnk-contracts";
import type { SchemeHandler } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const read = (source: string): ReadStatement => {
    const parsed = PlurnkParser.parseStatements(source);
    assert.equal(parsed.unparsedTail, undefined);
    assert.deepEqual(parsed.items.filter(({ kind }) => kind === "error"), []);
    const item = parsed.items.find(({ kind }) => kind === "statement");
    if (item?.kind !== "statement" || item.statement.op !== "READ") {
        throw new Error("fixture did not produce one READ statement");
    }
    return item.statement;
};

const manifest = (name: string, metadataModifier = false) => ({
    name,
    channels: { body: "text/plain" },
    defaultChannel: "body",
    category: "data" as const,
    entryOwner: "commons" as const,
    inherit: "none" as const,
    writableBy: ["model" as const],
    volatile: false,
    modelVisible: true,
    ...(metadataModifier ? { metadataModifier: true } : {}),
});

test("scheme metadata remains outside the target and reaches only an opted-in scheme", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `scheme-metadata-${crypto.randomUUID()}`);
    const schemes = new SchemeRegistry();
    let supportedMetadata: readonly string[] | null = null;
    let routedAliasMetadata: readonly string[] | null = null;
    let unsupportedInvoked = false;

    schemes.register("opaque", {
        manifest: manifest("opaque", true),
        async prepareRepresentation(request, ctx) {
            supportedMetadata = request.metadata;
            const written = await ctx.entries.write(request.pathname, {
                channels: { body: { content: "ready", mimetype: "text/plain" } },
            });
            assert.ok(written.status === 200 || written.status === 201);
            return { status: 200 } as const;
        },
    } satisfies SchemeHandler);
    schemes.register("plain", {
        manifest: manifest("plain"),
        async prepareRepresentation() {
            unsupportedInvoked = true;
            return { status: 200 } as const;
        },
    } satisfies SchemeHandler);
    schemes.register("https", {
        manifest: { ...manifest("https", true), authority: "resource" },
        async prepareRepresentation(request, ctx) {
            routedAliasMetadata = request.metadata;
            const written = await ctx.entries.write(request.pathname, {
                channels: { body: { content: "routed", mimetype: "text/plain" } },
            });
            assert.ok(written.status === 200 || written.status === 201);
            return { status: 200 } as const;
        },
    } satisfies SchemeHandler);
    const engine = new Engine({ db, schemes });

    try {
        const supported = read(
            "## READ0 (opaque:///record) {first: {nested}} {second: duplicate}",
        );
        assert.equal(supported.target?.raw, "opaque:///record");
        assert.deepEqual(supported.metadata, ["first: {nested}", "second: duplicate"]);
        const accepted = await engine.dispatch({
            statement: supported,
            ...env,
            sequence: 1,
            origin: "model",
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(supportedMetadata, ["first: {nested}", "second: duplicate"]);

        const routedAlias = await engine.dispatch({
            statement: read("## READ0 (http://example.test/record) {Accept: text/plain}"),
            ...env,
            sequence: 2,
            origin: "model",
        });
        assert.equal(routedAlias.status, 200);
        assert.deepEqual(routedAliasMetadata, ["Accept: text/plain"]);

        const rejected = await engine.dispatch({
            statement: read("## READ0 (plain:///record) {anything the scheme might define}"),
            ...env,
            sequence: 3,
            origin: "model",
        });
        assert.equal(rejected.status, 400);
        assert.equal(
            rejected.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/scheme-metadata-unsupported",
        );
        assert.equal(rejected.problem?.detail, "Scheme 'plain' does not accept the {metadata} modifier.");
        assert.equal(unsupportedInvoked, false);
    } finally {
        await schemes.close();
        await db.close();
    }
});
