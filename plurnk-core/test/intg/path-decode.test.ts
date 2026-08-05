// {§path-parentheses}: the pathname `%28`/`%29` alias decodes at consumer
// resolution; the contracts parser has already handled lexical target escapes.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import { PathSyntax } from "@plurnk/plurnk-contracts";
import Worker from "../../src/schemes/Worker.ts";
import { openMigrated, insertWorkspace, insertWorker, makeSchemeCtx } from "./_helpers.ts";

test("decodePathParens decodes only %28/%29 — other percent-sequences + literal % pass through", () => {
    assert.equal(PathSyntax.decodeParens("/dir/file%28v1%29.txt"), "/dir/file(v1).txt");
    assert.equal(PathSyntax.decodeParens("/a%28b%29c%28d%29"), "/a(b)c(d)");
    assert.equal(PathSyntax.decodeParens("/50%off %20literal.txt"), "/50%off %20literal.txt", "%20 + a literal % are untouched — only parens are grammar-encoded");
});

test("encodePathParens produces the model-facing inverse without touching existing escapes", () => {
    assert.equal(PathSyntax.encodeParens("/wiki/Igor_(politician)"), "/wiki/Igor_%28politician%29");
    assert.equal(PathSyntax.encodeParens("/wiki/Igor_%28politician%29"), "/wiki/Igor_%28politician%29");
});

const enc = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({ op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body, position: { line: 1, column: 1 } });
const readStmt = (target: UrlPath): ReadStatement => ({ op: "READ", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } });

test("{§path-parentheses} a percent-encoded pathname alias resolves to literal parentheses", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `paren-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, workerId });

        const w = await new Worker().edit(editStmt(enc("doc%28v1%29.md"), "paren body"), ctx);
        assert.ok(w.status === 200 || w.status === 201, "the encoded-paren EDIT lands");

        // READ of the encoded form resolves the entry the EDIT created.
        const r = await new Worker().read(readStmt(enc("doc%28v1%29.md")), ctx);
        assert.equal(r.status, 200, "READ of the encoded form resolves the entry");
        assert.match(r.content ?? "", /paren body/, "and returns its content");

        // The decisive check: the EDIT stored at the DECODED path, so the LITERAL-paren form
        // addresses the same entry. Without decode-at-resolve it would 404 here.
        const literal = await new Worker().read(readStmt(enc("doc(v1).md")), ctx);
        assert.equal(literal.status, 200, "the literal-paren form hits the same entry — proof the EDIT resolved decoded");
    } finally { await db.close(); }
});
