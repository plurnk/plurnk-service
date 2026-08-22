import assert from "node:assert/strict";
import test from "node:test";
import { parsePath, type UrlPath } from "@plurnk/plurnk-contracts";
import NetworkAddress from "./NetworkAddress.ts";

const network = (raw: string): NetworkAddress => {
    const parsed = parsePath(raw);
    assert.equal(parsed?.kind, "url");
    return NetworkAddress.from(parsed as UrlPath);
};

test("network identity includes addressed scheme, canonical authority, path, and ordered query", () => {
    const address = network("HTTPS://Example.COM:8443/a/../socket%28v1%29?b=2&a=1&b=3");
    assert.equal(address.scheme, "https");
    assert.equal(address.authority, "example.com:8443");
    assert.equal(address.pathname, "/socket(v1)?b=2&a=1&b=3");
    assert.equal(address.url, "https://example.com:8443/socket%28v1%29?b=2&a=1&b=3");
    assert.equal(
        NetworkAddress.render(address),
        "https://example.com:8443/socket%28v1%29?b=2&a=1&b=3",
    );
});

test("default ports canonicalize while non-default ports distinguish authorities", () => {
    assert.equal(network("http://example.com:80/x").authority, "example.com");
    assert.equal(network("https://example.com:443/x").authority, "example.com");
    assert.notEqual(network("https://example.com:444/x").authority, network("https://example.com/x").authority);
});

test("query absence, an empty query, ordering, and duplicates remain distinct", () => {
    assert.equal(network("https://example.com/x").pathname, "/x");
    assert.equal(network("https://example.com/x?").pathname, "/x?");
    assert.notEqual(network("https://example.com/x?a=1&b=2").pathname, network("https://example.com/x?b=2&a=1").pathname);
    assert.equal(network("https://example.com/x?a=1&a=2").pathname, "/x?a=1&a=2");
});

test("render encodes canonical path parentheses without rewriting query spelling", () => {
    const address = network("https://example.com/path%28v1%29?q=(literal)&q=%28encoded%29");
    assert.equal(address.pathname, "/path(v1)?q=(literal)&q=%28encoded%29");
    assert.equal(
        address.url,
        "https://example.com/path%28v1%29?q=(literal)&q=%28encoded%29",
        "transport identity never receives model-target escaping",
    );
    assert.equal(
        NetworkAddress.render(address),
        String.raw`https://example.com/path%28v1%29?q=\(literal\)&q=%28encoded%29`,
    );
});

test("fragment, credentials, and request metadata are excluded from identity and transport", () => {
    const address = network("https://alice:secret@example.com/x?q=1#preview{Authorization: Bearer secret}");
    assert.equal(address.authority, "example.com");
    assert.equal(address.pathname, "/x?q=1");
    assert.equal(address.url, "https://example.com/x?q=1");
    assert.equal(address.hasCredentials, true);
    assert.doesNotMatch(address.url, /alice|secret|Authorization|preview/);
});

test("HTTP and WebSocket protocols remain distinct addressed identities", () => {
    assert.equal(network("ws://example.com/x").pathname, network("wss://example.com/x").pathname);
    assert.notEqual(network("ws://example.com/x").scheme, network("wss://example.com/x").scheme);
    assert.notEqual(network("http://example.com/x").scheme, network("ws://example.com/x").scheme);
});
