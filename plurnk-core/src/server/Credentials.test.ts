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
    assert.equal(authority.face()?.issuer({ headers: {} }), "http://127.0.0.1:1");
    assert.throws(() => authority.publish({ issuer: () => "http://elsewhere" }), /already has an issuing face/u);
});

test("{§credential-authority} a credential needs a positive lifetime and its three names", () => {
    const authority = new Credentials();
    assert.throws(() => authority.issue(claims({ ttlMs: 0 })), /positive lifetime/u);
    assert.throws(() => authority.issue(claims({ subject: "" })), /subject/u);
    assert.throws(() => authority.issue(claims({ family: "" })), /family/u);
});

test("{§credential-authority} the posture is PLURNK_AUTH alone: on, the secret is configured or minted for this boot; off, none exists", () => {
    assert.throws(() => Credentials.posture({}), /PLURNK_AUTH is missing from the assembled environment floor/u);
    assert.throws(() => Credentials.posture({ PLURNK_AUTH: "yes" }), /PLURNK_AUTH must be 0 or 1/u);
    assert.deepEqual(Credentials.posture({ PLURNK_AUTH: "0", PLURNK_SECRET: "configured" }), { authenticates: false, secret: null, minted: false },
        "off is off, whatever else is set");
    assert.deepEqual(Credentials.posture({ PLURNK_AUTH: "1", PLURNK_SECRET: "configured" }), { authenticates: true, secret: "configured", minted: false });
    const minted = Credentials.posture({ PLURNK_AUTH: "1" });
    assert.equal(minted.authenticates, true);
    assert.equal(minted.minted, true);
    assert.match(minted.secret ?? "", /^[A-Za-z0-9_-]{43}$/u, "a minted secret is long, url-safe and header-safe");
    assert.notEqual(minted.secret, Credentials.posture({ PLURNK_AUTH: "1", PLURNK_SECRET: "" }).secret, "every boot mints its own; an empty value is unset");
    assert.equal(new Credentials({ operatorSecret: "s" }).operatorSecret, "s");
    assert.equal(new Credentials().operatorSecret, null);
});

test("{§credential-authority} a minted secret is written beside the database, 0600 and complete, and removed when nothing minted it", async () => {
    const { mkdtemp, readFile, rm, stat, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "plurnk-secret-"));
    try {
        const path = Credentials.secretPath(join(dir, "plurnk.db"));
        assert.equal(path, join(dir, "secret"));
        await Credentials.writeSecret(path, "first");
        assert.equal(await readFile(path, "utf8"), "first\n");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        await Credentials.writeSecret(path, "second");
        assert.equal(await readFile(path, "utf8"), "second\n", "a later boot overwrites the file in place");
        assert.deepEqual(await readdir(dir), ["secret"], "no staging file outlives the write");
        await Credentials.removeSecret(path);
        await assert.rejects(readFile(path), { code: "ENOENT" });
        await Credentials.removeSecret(path);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§credential-sessions} a subject's live browser sign-ins are listed by family, oldest first, with their clients and never a token", () => {
    let now = 1_000;
    const authority = new Credentials({ now: () => now });
    const signIn = { kind: "session", subject: "operator", clientId: "browser", scopes: ["agui"] } as const;
    const cookie = authority.issue({ ...signIn, family: "first", ttlMs: 10_000 });
    const access = authority.issue({ kind: "access", subject: "operator", clientId: "web", scopes: ["agui"], family: "first", ttlMs: 1_000 });
    authority.issue({ ...signIn, clientId: "web", family: "first", ttlMs: 20_000 });
    now = 2_000;
    authority.issue({ ...signIn, family: "second", ttlMs: 5_000 });
    // Neither is a sign-in of the operator's: a grant holding no session credential, and another subject's.
    authority.issue({ kind: "access", subject: "operator", clientId: "terminal", scopes: ["agui"], family: "grant", ttlMs: 5_000 });
    authority.issue({ ...signIn, subject: "someone", family: "theirs", ttlMs: 5_000 });

    const listed = authority.sessions("operator");
    assert.deepEqual(listed, [
        { family: "first", subject: "operator", createdAt: 1_000, expiresAt: 21_000, clients: ["browser", "web"] },
        { family: "second", subject: "operator", createdAt: 2_000, expiresAt: 7_000, clients: ["browser"] },
    ], "established when first issued into; expiring with the last of its session credentials");
    assert.ok(![cookie.token, access.token].some((token) => JSON.stringify(listed).includes(token)), "no token is told");
    assert.ok(Object.isFrozen(listed) && Object.isFrozen(listed[0]) && Object.isFrozen(listed[0]!.clients));
    assert.deepEqual(authority.sessions("someone").map(({ family }) => family), ["theirs"]);
    assert.deepEqual(authority.sessions("nobody"), []);
    assert.equal(authority.verify("first"), null, "a family is a handle, never a credential");

    authority.revokeFamily("first");
    assert.deepEqual(authority.sessions("operator").map(({ family }) => family), ["second"], "a revoked sign-in is gone");
    now = 7_000;
    assert.deepEqual(authority.sessions("operator"), [], "and so is an expired one");
    // A family issued into again after it ended is a new sign-in, established then.
    authority.issue({ ...signIn, family: "first", ttlMs: 1_000 });
    assert.equal(authority.sessions("operator")[0]?.createdAt, 7_000);
});

test("{§credential-module-client} a module registers its own confidential client once: the secret is minted here, told to the registrant alone and checked here", () => {
    const authority = new Credentials();
    const web = authority.registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["agui", "agui"] });
    assert.equal(web.clientId, "web");
    assert.match(web.clientSecret, /^[A-Za-z0-9_-]{43}$/u);
    assert.deepEqual(authority.client("web"), { id: "web", redirectPaths: ["/web/callback"], scopes: ["agui"] }, "what others may know: never the secret, and no origin");
    assert.ok(Object.isFrozen(authority.client("web")) && Object.isFrozen(authority.client("web")!.redirectPaths));
    assert.equal(authority.client("nobody"), null);
    assert.equal(authority.authenticateClient("web", web.clientSecret), true);
    assert.equal(authority.authenticateClient("web", `${web.clientSecret}x`), false);
    assert.equal(authority.authenticateClient("web", ""), false);
    assert.equal(authority.authenticateClient("nobody", web.clientSecret), false);
    assert.throws(() => authority.registerClient({ id: "web", redirectPaths: ["/other"], scopes: ["agui"] }), /already has a module client 'web'/u);
    const other = new Credentials().registerClient({ id: "web", redirectPaths: ["/web/callback"], scopes: ["agui"] });
    assert.notEqual(other.clientSecret, web.clientSecret, "every boot mints its own");
});

test("{§credential-module-client} a module client's registration is refused when its id, its redirect paths or its scopes are malformed", () => {
    const authority = new Credentials();
    const good = { id: "web", redirectPaths: ["/web/callback", "/"], scopes: ["agui"] };
    for (const id of ["", "operator", "no spaces", "sl/ash"]) assert.throws(() => authority.registerClient({ ...good, id }), /module client id/u, JSON.stringify(id));
    // An origin is never the module's to state, and the path is the one a URL carries, unrewritten.
    for (const redirectPaths of [
        [], ["relative"], ["http://127.0.0.1:1066/web/callback"], ["//elsewhere.example/web/callback"], ["/web/callback?next=1"],
        ["/web/callback#fragment"], ["/web/../callback"], ["/web callback"], ["/web/callback", "relative"], [7 as unknown as string],
    ]) {
        assert.throws(() => authority.registerClient({ ...good, redirectPaths }), /needs redirectPaths/u, JSON.stringify(redirectPaths));
    }
    for (const scopes of [[], [""], ["two words"], [7 as unknown as string]]) assert.throws(() => authority.registerClient({ ...good, scopes }), /needs scopes/u, JSON.stringify(scopes));
    // {§agui-oauth-documents} — a stylesheet is a path the module serves, in the form its redirect paths take.
    for (const stylesheetPath of ["", "relative.css", "https://elsewhere.example/a.css", "//elsewhere.example/a.css", "/a.css?v=1", "/a.css#x", 7 as unknown as string]) {
        assert.throws(() => authority.registerClient({ ...good, stylesheetPath }), /stylesheetPath/u, JSON.stringify(stylesheetPath));
    }
    assert.equal(authority.client("web"), null, "a refused registration registers nothing");
    assert.equal(authority.registerClient({ ...good, stylesheetPath: "/web/assets/authority.css" }).clientId, "web");
    assert.equal(authority.client("web")?.stylesheetPath, "/web/assets/authority.css");
});
