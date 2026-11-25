// {§ambient-http-transport} — canonical public-address SSRF guard coverage.
// Hermetic: IP literals and static protocol checks only (no DNS).

import test from "node:test";
import assert from "node:assert/strict";
import { GuardBlockedError, isPublicAddress, isPublicUrl } from "./index.ts";

test("{§ambient-http-transport} isPublicAddress rejects non-global IPv4/IPv6 ranges and admits global addresses", () => {
    for (const blocked of [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "100.127.255.254",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "172.31.255.255",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "2001::1",
        "2001:db8::1",
        "2002:c000:0201::1",
        "3fff::1",
        "fc00::1",
        "fd00::1",
        "fe80::1",
        "ff02::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
        "::ffff:a9fe:a9fe",
        "not-an-ip",
    ]) {
        assert.equal(isPublicAddress(blocked), false, `${blocked} must be refused`);
    }
    for (const allowed of [
        "1.1.1.1",
        "8.8.8.8",
        "11.0.0.1",
        "93.184.216.34",
        "100.63.255.255",
        "100.128.0.1",
        "172.15.255.255",
        "172.32.0.1",
        "2606:4700:4700::1111",
        "::ffff:8.8.8.8",
        "::ffff:808:808",
    ]) {
        assert.equal(isPublicAddress(allowed), true, `${allowed} must be admitted`);
    }
});

test("{§ambient-http-transport} isPublicUrl enforces protocol list, credential-free URLs, localhost denial, and IP literals", async () => {
    for (const blocked of [
        "ftp://8.8.8.8/",
        "file:///etc/passwd",
        "ws://8.8.8.8/feed",
        "wss://93.184.216.34/feed",
        "http://localhost/",
        "https://sub.localhost/",
        "http://127.0.0.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "https://user:secret@8.8.8.8/",
        "https://user@8.8.8.8/",
        "not a url",
    ]) {
        assert.equal(await isPublicUrl(blocked), false, `${blocked} must be refused`);
    }
    assert.equal(await isPublicUrl("https://8.8.8.8/"), true);
    assert.equal(await isPublicUrl("http://[2606:4700:4700::1111]/"), true);

    assert.equal(await isPublicUrl("ws://93.184.216.34/feed", { protocols: ["ws:", "wss:"] }), true);
    assert.equal(await isPublicUrl("wss://[2606:4700:4700::1111]/feed", { protocols: ["ws:", "wss:"] }), true);
    assert.equal(await isPublicUrl("ws://127.0.0.1/feed", { protocols: ["ws:", "wss:"] }), false);
    assert.equal(await isPublicUrl("wss://169.254.169.254/feed", { protocols: ["ws:", "wss:"] }), false);
    assert.equal(await isPublicUrl("https://93.184.216.34/feed", { protocols: ["ws:", "wss:"] }), false);
});

test("{§ambient-http-transport} GuardBlockedError sanitizes embedded credentials from url and message", () => {
    const error = new GuardBlockedError("https://alice:top-secret@127.0.0.1:8080/internal");
    assert.equal(error.name, "GuardBlockedError");
    assert.equal(error.url, "https://127.0.0.1:8080/internal");
    assert.equal(error.message.includes("alice"), false);
    assert.equal(error.message.includes("top-secret"), false);
});
