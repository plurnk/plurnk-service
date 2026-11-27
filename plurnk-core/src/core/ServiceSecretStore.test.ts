import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ServiceSecretStore from "./ServiceSecretStore.ts";

test("{§operator-config-precedence} ServiceSecretStore round-trips encrypted secrets at 0600, redacting plaintext on disk, and fails closed on tamper", async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "plurnk-secret-store-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));

    const store = new ServiceSecretStore({ stateDir });
    assert.deepEqual([...(await store.load())], []);
    assert.deepEqual([...store.loadSync()], []);

    const secretA = "sk-live-secret-witness-alpha-987654321";
    const secretB = "sk-live-secret-witness-beta-123456789";
    await store.set("OPENAI_API_KEY", secretA);
    await store.set("ANTHROPIC_API_KEY", secretB);

    // Permissions & ciphertext isolation on disk.
    const encStat = await stat(store.filePath);
    const keyStat = await stat(join(stateDir, ".config-key"));
    assert.equal(encStat.mode & 0o777, 0o600, "encrypted secrets file is owner-only 0600");
    assert.equal(keyStat.mode & 0o777, 0o600, "master key file is owner-only 0600");

    const rawBytes = await readFile(store.filePath);
    assert.equal(rawBytes.subarray(0, 8).toString("ascii"), "PLKCFG01");
    assert.equal(rawBytes.includes(Buffer.from(secretA)), false, "plaintext secret A never appears on disk");
    assert.equal(rawBytes.includes(Buffer.from(secretB)), false, "plaintext secret B never appears on disk");
    assert.equal(rawBytes.includes(Buffer.from("OPENAI_API_KEY")), false, "plaintext key name is encrypted");

    // Fresh store instance reads both async and sync identically.
    const reader = new ServiceSecretStore({ stateDir });
    assert.deepEqual(Object.fromEntries(await reader.load()), {
        ANTHROPIC_API_KEY: secretB,
        OPENAI_API_KEY: secretA,
    });
    assert.deepEqual(Object.fromEntries(reader.loadSync()), {
        ANTHROPIC_API_KEY: secretB,
        OPENAI_API_KEY: secretA,
    });

    // Concurrent updates serialize without dropping writes.
    await Promise.all([
        store.set("DEEPSEEK_API_KEY", "sk-ds-1"),
        store.set("OPENROUTER_API_KEY", "sk-or-2"),
    ]);
    assert.equal((await reader.load()).get("DEEPSEEK_API_KEY"), "sk-ds-1");
    assert.equal((await reader.load()).get("OPENROUTER_API_KEY"), "sk-or-2");

    // Delete removes one key and preserves siblings.
    const deleted = await store.delete("OPENAI_API_KEY");
    assert.equal(deleted.removed, true);
    assert.equal((await store.delete("OPENAI_API_KEY")).removed, false);
    assert.equal((await reader.load()).has("OPENAI_API_KEY"), false);
    assert.equal((await reader.load()).get("ANTHROPIC_API_KEY"), secretB);

    // Tampering with ciphertext fails closed on both load() and loadSync().
    const tampered = Buffer.from(await readFile(store.filePath));
    tampered[tampered.length - 1] ^= 0xff;
    await writeFile(store.filePath, tampered, { mode: 0o600 });
    await assert.rejects(() => reader.load(), /unable to authenticate|unsupported state/iu);
    assert.throws(() => reader.loadSync(), /unable to authenticate|unsupported state/iu);

    // Corrupt magic fails closed too.
    const badMagic = Buffer.from(rawBytes);
    badMagic[0] = 0x00;
    await writeFile(store.filePath, badMagic, { mode: 0o600 });
    await assert.rejects(() => reader.load(), /invalid service secret store magic/u);
});

test("{§env-functionality} {§operator-config-precedence} ServiceSecretStore isolates custom purpose files with domain-separated HKDF and AAD", async (t) => {
    const stateDir = await mkdtemp(join(tmpdir(), "plurnk-env-secret-store-"));
    t.after(() => rm(stateDir, { recursive: true, force: true }));

    const configStore = new ServiceSecretStore({ stateDir });
    const envStore = new ServiceSecretStore({ stateDir }, { fileName: "env-secrets.enc", purpose: "env-secrets" });

    await configStore.set("OPENAI_API_KEY", "sk-config-secret");
    await envStore.set("MCP_TOKEN", "tok-env-secret");

    assert.equal((await configStore.load()).get("OPENAI_API_KEY"), "sk-config-secret");
    assert.equal((await configStore.load()).has("MCP_TOKEN"), false);
    assert.equal((await envStore.load()).get("MCP_TOKEN"), "tok-env-secret");
    assert.equal((await envStore.load()).has("OPENAI_API_KEY"), false);

    // Cross-purpose ciphertext swap fails closed despite sharing `.config-key`.
    const envBytes = await readFile(envStore.filePath);
    await writeFile(configStore.filePath, envBytes, { mode: 0o600 });
    await assert.rejects(() => configStore.load(), /unable to authenticate|unsupported state/iu);
});
