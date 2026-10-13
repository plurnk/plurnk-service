import assert from "node:assert/strict";
import test from "node:test";
import Credentials from "./Credentials.ts";

const claims = (overrides: Partial<Parameters<Credentials["issue"]>[0]> = {}): Parameters<Credentials["issue"]>[0] => ({
    kind: "access", subject: "operator", clientId: "operator", scopes: ["agui"], family: "grant-1", ttlMs: 1_000, ...overrides,
});

test("{§credential-authority} an issued credential verifies until it expires, and a stranger never does", () => {
    let now = 1_000;
    const authority = new Credentials({ now: () => now });
    const issued = authority.issue(claims());
    assert.equal(issued.expiresAt, 2_000);
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/u, "an opaque random token, never a claim encoding");
    assert.deepEqual(authority.verify(issued.token), {
        kind: "access", subject: "operator", clientId: "operator", scopes: ["agui"], family: "grant-1", expiresAt: 2_000,
    });
    assert.equal(authority.verify("not-a-token"), null);
    now = 2_000;
    assert.equal(authority.verify(issued.token), null, "expiry is exact");
    assert.notEqual(authority.issue(claims()).token, authority.issue(claims()).token, "every issue is fresh");
});

test("{§credential-authority} a refresh token is consumed once; its reuse revokes the family and says so", () => {
    const authority = new Credentials({ now: () => 0 });
    const revoked: string[] = [];
    authority.onRevoked((family) => revoked.push(family));
    const access = authority.issue(claims({ kind: "access", family: "grant-2", ttlMs: 60_000 }));
    const refresh = authority.issue(claims({ kind: "refresh", family: "grant-2", ttlMs: 60_000 }));
    const consumed = authority.consume(refresh.token);
    assert.ok("claims" in consumed && consumed.claims.kind === "refresh", "the first presentation exchanges");
    assert.equal(authority.verify(refresh.token), null, "a consumed token is no longer live");
    assert.notEqual(authority.verify(access.token), null, "rotation alone revokes nothing else");
    const rotated = authority.issue(claims({ kind: "refresh", family: "grant-2", ttlMs: 60_000 }));
    assert.deepEqual(authority.consume(refresh.token), { reusedFamily: "grant-2" }, "a second presentation is reuse");
    assert.equal(authority.verify(access.token), null, "reuse ends the access token");
    assert.equal(authority.verify(rotated.token), null, "and the rotated refresh token");
    assert.deepEqual(revoked, ["grant-2"]);
    assert.deepEqual(authority.consume(access.token), { reusedFamily: null }, "an access token is never exchanged");
    assert.deepEqual(authority.consume("unknown"), { reusedFamily: null });
});

test("{§credential-authority} revocation is by family and reaches every listener, idempotently", () => {
    const authority = new Credentials({ now: () => 0 });
    const heard: string[] = [];
    const off = authority.onRevoked((family) => heard.push(family));
    const one = authority.issue(claims({ family: "one" }));
    const two = authority.issue(claims({ family: "two" }));
    authority.revokeFamily("one");
    assert.equal(authority.verify(one.token), null);
    assert.notEqual(authority.verify(two.token), null, "another family stands");
    authority.revokeFamily("one");
    assert.deepEqual(heard, ["one", "one"], "every revocation is announced, even of nothing");
    off();
    authority.revokeFamily("two");
    assert.deepEqual(heard, ["one", "one"], "an unsubscribed listener hears nothing more");
});

test("{§credential-authority} the authority has at most one issuing face, and none means the daemon authenticates nothing", () => {
    const authority = new Credentials();
    assert.equal(authority.face(), null);
    authority.publish({ issuer: () => "http://127.0.0.1:1" });
    assert.equal(authority.face()?.issuer(), "http://127.0.0.1:1");
    assert.throws(() => authority.publish({ issuer: () => "http://elsewhere" }), /already has an issuing face/u);
});

test("{§credential-authority} a credential needs a positive lifetime and its three names", () => {
    const authority = new Credentials();
    assert.throws(() => authority.issue(claims({ ttlMs: 0 })), /positive lifetime/u);
    assert.throws(() => authority.issue(claims({ subject: "" })), /subject/u);
    assert.throws(() => authority.issue(claims({ family: "" })), /family/u);
});
