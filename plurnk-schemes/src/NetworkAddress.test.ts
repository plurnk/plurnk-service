import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePath } from "@plurnk/plurnk-parser";
import FileByteSource from "./FileByteSource.ts";
import GeneratedByteSource from "./GeneratedByteSource.ts";
import NetworkAddress from "./NetworkAddress.ts";
import ResourceNames from "./ResourceNames.ts";

const network = (raw: string): NetworkAddress => {
    const parsed = parsePath(raw);
    assert.equal(parsed?.kind, "url");
    return NetworkAddress.from(parsed);
};

test("{§network-address} network identity includes addressed scheme, canonical authority, path, and ordered query", () => {
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

test("{§network-address} default ports canonicalize while non-default ports distinguish authorities", () => {
    assert.equal(network("http://example.com:80/x").authority, "example.com");
    assert.equal(network("https://example.com:443/x").authority, "example.com");
    assert.notEqual(network("https://example.com:444/x").authority, network("https://example.com/x").authority);
});

test("{§network-address} query absence, an empty query, ordering, and duplicates remain distinct", () => {
    assert.equal(network("https://example.com/x").pathname, "/x");
    assert.equal(network("https://example.com/x?").pathname, "/x?");
    assert.notEqual(network("https://example.com/x?a=1&b=2").pathname, network("https://example.com/x?b=2&a=1").pathname);
    assert.equal(network("https://example.com/x?a=1&a=2").pathname, "/x?a=1&a=2");
});

test("{§network-address} render encodes canonical path parentheses without rewriting query spelling", () => {
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

test("{§network-address} fragment, credentials, and request metadata are excluded from identity and transport", () => {
    const address = network("https://alice:secret@example.com/x?q=1#preview[{\"Authorization\": \"Bearer secret\"}]");
    assert.equal(address.authority, "example.com");
    assert.equal(address.pathname, "/x?q=1");
    assert.equal(address.url, "https://example.com/x?q=1");
    assert.equal(address.hasCredentials, true);
    assert.doesNotMatch(address.url, /alice|secret|Authorization|preview/);
});

test("{§network-address} HTTP and WebSocket protocols remain distinct addressed identities", () => {
    assert.equal(network("ws://example.com/x").pathname, network("wss://example.com/x").pathname);
    assert.notEqual(network("ws://example.com/x").scheme, network("wss://example.com/x").scheme);
    assert.notEqual(network("http://example.com/x").scheme, network("ws://example.com/x").scheme);
});

test("{§scheme-operation-dispatch} names survive; unnamed and duplicate publications use eight hex characters", () => {
    const names = new ResourceNames();
    assert.equal(decodeURIComponent(names.allocate("screenshot.png")), "screenshot.png");
    assert.match(names.allocate("screenshot.png"), /^screenshot\.png\.[a-f0-9]{8}$/u);
    assert.match(names.allocate(), /^[a-f0-9]{8}$/u);
    assert.equal(names.allocate("../a (b)#x.png"), "..%2Fa%20%28b%29%23x.png", "a supplied name remains one address component");
    assert.match(names.allocate(".."), /^[a-f0-9]{8}$/u);
    const stable = (): string[] => {
        const collection = new ResourceNames();
        return [collection.allocate(undefined, "first"), collection.allocate("same", "a"), collection.allocate("same", "b")];
    };
    assert.deepEqual(stable(), stable(), "reconstructing a collection preserves its resource paths");
});

test("{§scheme-operation-dispatch} native identity and inclusive byte windows share one live source", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-byte-source-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, "asset.bin");
    await writeFile(file, Buffer.from([0, 255, 128, 65]));
    const source = new FileByteSource(async () => file);
    assert.equal(await source.nativePath(), file);
    assert.equal(await source.size(), 4);
    assert.deepEqual(await source.read(2, 3), Buffer.from([255, 128]));
    assert.deepEqual(await source.read(4, 8), Buffer.from([65]));
    await writeFile(file, "new");
    assert.equal(await source.size(), 3);
    assert.deepEqual(await source.read(1, 3), Buffer.from("new"));
    await rm(file);
    assert.equal(await source.nativePath(), null);
    assert.equal(await source.size(), null);
    await assert.rejects(source.read(1, 1), /no longer exists/);
    await assert.rejects(new FileByteSource(async () => directory).nativePath(), /not a regular file/);
});

test("{§scheme-operation-dispatch} unavailable and failed resolution are distinct", async () => {
    assert.equal(await new FileByteSource(async () => null).nativePath(), null);
    const failure = new Error("source admission refused");
    const source = new FileByteSource(async () => { throw failure; });
    await assert.rejects(source.nativePath(), (cause) => cause === failure);
    await assert.rejects(source.size(), (cause) => cause === failure);
    await assert.rejects(source.read(1, 1), (cause) => cause === failure);
});

test("{§scheme-operation-dispatch} generated bytes are lazy, consistent, and have no fabricated file", async () => {
    let calls = 0;
    const source = new GeneratedByteSource(async () => {
        calls++;
        return Uint8Array.of(0, 255, 128, 65);
    });
    assert.equal(calls, 0);
    assert.equal("nativePath" in source, false);
    assert.equal(await source.size(), 4);
    assert.deepEqual(await source.read(2, 3), Uint8Array.of(255, 128));
    assert.deepEqual(await source.read(4, 8), Uint8Array.of(65));
    assert.deepEqual(await source.read(1, 0), new Uint8Array());
    assert.equal(calls, 1);
});

test("{§scheme-operation-dispatch} generated absence and generation failures remain distinct", async () => {
    const absent = new GeneratedByteSource(async () => null);
    assert.equal(await absent.size(), null);
    await assert.rejects(absent.read(1, 1), /no longer exists/);
    const failure = new Error("catalog generation failed");
    const broken = new GeneratedByteSource(async () => { throw failure; });
    await assert.rejects(broken.size(), (cause) => cause === failure);
    await assert.rejects(broken.read(1, 1), (cause) => cause === failure);
});
