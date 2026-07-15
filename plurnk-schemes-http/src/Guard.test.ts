// SSRF guard unit tests. Fully hermetic — pure range checks and IP-literal URLs
// (net.isIP short-circuits DNS). Redirect-hop count reads
// PLURNK_SCHEMES_HTTP_REDIRECTS from .env.defaults via --env-file.

import test from "node:test";
import { strict as assert } from "node:assert";
import Guard, { GuardBlockedError } from "./Guard.ts";

test("isPublicAddress: blocks RFC-reserved v4 ranges", () => {
    for (const ip of ["0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.0.1"]) {
        assert.equal(Guard.isPublicAddress(ip), false, `${ip} should be private`);
    }
});

test("isPublicAddress: allows public v4 (incl. range boundaries)", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "1.1.1.1", "11.0.0.1", "172.15.0.1", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) {
        assert.equal(Guard.isPublicAddress(ip), true, `${ip} should be public`);
    }
});

test("isPublicAddress: blocks reserved v6, re-checks v4-mapped", () => {
    for (const ip of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.0.1"]) {
        assert.equal(Guard.isPublicAddress(ip), false, `${ip} should be private`);
    }
    assert.equal(Guard.isPublicAddress("2606:4700:4700::1111"), true);
    assert.equal(Guard.isPublicAddress("::ffff:8.8.8.8"), true);
});

test("isPublicUrl: protocol / localhost / IP-literal, no DNS", async () => {
    for (const bad of ["ftp://8.8.8.8/", "file:///etc/passwd", "http://localhost/", "http://x.localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "not a url"]) {
        assert.equal(await Guard.isPublicUrl(bad), false, `${bad} should be refused`);
    }
    assert.equal(await Guard.isPublicUrl("https://8.8.8.8/"), true);
    assert.equal(await Guard.isPublicUrl("http://[2606:4700:4700::1111]/"), true);
});

test("Guard.fetch: a private target is refused before any fetch", async () => {
    const orig = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    try {
        await assert.rejects(
            Guard.fetch("http://127.0.0.1/", { method: "GET", body: undefined, headers: [] }, AbortSignal.timeout(2000)),
            (e) => e instanceof GuardBlockedError,
        );
        assert.equal(called, false);
    } finally { globalThis.fetch = orig; }
});

test("Guard.fetch: a redirect INTO private space is re-guarded and refused", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string | URL | Request) =>
        String(u).includes("8.8.8.8")
            ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } })
            : new Response("private-body")) as typeof fetch;
    try {
        await assert.rejects(
            Guard.fetch("http://8.8.8.8/", { method: "GET", body: undefined, headers: [] }, AbortSignal.timeout(2000)),
            (e) => e instanceof GuardBlockedError,
        );
    } finally { globalThis.fetch = orig; }
});
