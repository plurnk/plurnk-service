import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser, type ReadStatement } from "@plurnk/plurnk-contracts";
import type { SchemeHandler } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, seedEntryWithChannel, seedEnvelope, fixtureExecutors } from "./_helpers.ts";

const read = (source: string): ReadStatement => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
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
            "```READ (opaque:///record) [{\"first\": {\"nested\": true}}] [{\"second\": \"duplicate\"}]```",
        );
        assert.equal(supported.target?.raw, "opaque:///record");
        assert.deepEqual(supported.metadata, ['{"first": {"nested": true}}', '{"second": "duplicate"}']);
        const accepted = await engine.dispatch({
            statement: supported,
            ...env,
            sequence: 1,
            origin: "model",
        });
        assert.equal(accepted.status, 200);
        assert.deepEqual(supportedMetadata, ['{"first": {"nested": true}}', '{"second": "duplicate"}']);

        const routedAlias = await engine.dispatch({
            statement: read("```READ (http://example.test/record) [{\"Accept\": \"text/plain\"}]```"),
            ...env,
            sequence: 2,
            origin: "model",
        });
        assert.equal(routedAlias.status, 200);
        assert.deepEqual(routedAliasMetadata, ['{"Accept": "text/plain"}']);

        const rejected = await engine.dispatch({
            statement: read("```READ (plain:///record) [{\"anything\": \"the scheme might define\"}]```"),
            ...env,
            sequence: 3,
            origin: "model",
        });
        assert.equal(rejected.status, 400);
        assert.equal(
            rejected.problem?.type,
            "https://problems.plurnk.xyz/engine/dispatcher/scheme-metadata-unsupported",
        );
        assert.equal(rejected.problem?.detail, "Scheme 'plain' does not accept the [metadata] modifier.");
        assert.equal(unsupportedInvoked, false);
    } finally {
        await schemes.close();
        await db.close();
    }
});

for (const op of ["COPY", "MOVE"] as const) {
    test(`{§transfer-resource-selections}: parsed ${op} keeps each scope and metadata with its resource through dispatch`, async () => {
        const db = await openMigrated();
        const env = await seedEnvelope(db, `transfer-metadata-${crypto.randomUUID()}`);
        const schemes = new SchemeRegistry();
        const reads: unknown[] = [];
        const writes: unknown[] = [];
        schemes.register("opaque", {
            manifest: { ...manifest("opaque", true), textEditScopes: true },
            async prepareRepresentation(request) {
                reads.push({ path: request.pathname, metadata: request.metadata });
                return { status: 200 };
            },
            async editBatch(statements, ctx) {
                writes.push(...statements.map(({ target, metadata }) => ({ path: target?.raw, metadata })));
                return ctx.entries.operations.editBatch(statements);
            },
        } satisfies SchemeHandler);
        const engine = new Engine({ db, schemes });
        try {
            for (const [pathname, content] of [["/source", "first\nselected\nlast"], ["/destination", "before\nreplace\nafter"]]) {
                await seedEntryWithChannel(db, { workspaceId: env.workspaceId, scheme: "opaque", pathname, content });
            }
            const parsed = PlurnkParser.parseStatements(
                `\`\`\`${op} (opaque:///source) <2> [{"source": "true"}] (opaque:///destination) <2> [{"destination": "true"}]\`\`\``,
            );
            assert.equal(parsed.unparsedTail, undefined);
            assert.equal(parsed.items.length, 1);
            const item = parsed.items[0];
            assert.ok(item?.kind === "statement" && item.statement.op === op);
            const result = await engine.dispatch({ statement: item.statement, ...env, sequence: 1, origin: "model" });
            assert.equal(result.status, 200);
            assert.deepEqual(reads, [{ path: "/source", metadata: ['{"source": "true"}'] }]);
            assert.deepEqual(writes, [
                { path: "opaque:///destination", metadata: ['{"destination": "true"}'] },
                ...(op === "MOVE" ? [{ path: "opaque:///source", metadata: ['{"source": "true"}'] }] : []),
            ]);
            for (const [pathname, expected] of [
                ["/source", op === "COPY" ? "first\nselected\nlast" : "first\nlast"],
                ["/destination", "before\nselected\nafter"],
            ]) {
                const channel = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                    scheme: "opaque", pathname, name: "body",
                });
                assert.equal(channel?.content, expected);
            }
        } finally {
            await schemes.close();
            await db.close();
        }
    });
}
