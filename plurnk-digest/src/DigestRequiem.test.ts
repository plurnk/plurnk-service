import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import Digest from "./Digest.ts";

for (const suffix of ["MAX_TOKENS", "RETRY_MAX_TOKENS"]) {
    test(`{§digest-requiem}: the retired ${suffix} setting names its successor before reading or calling`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "plurnk-requiem-setting-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        const dbPath = join(root, "plurnk.db");
        await writeFile(dbPath, "not opened");
        const retired = `PLURNK_SERVICE_REQUIEM_${suffix}`;
        const current = `PLURNK_DIGEST_REQUIEM_${suffix}`;
        const previous = process.env[retired];
        t.after(() => { if (previous === undefined) delete process.env[retired]; else process.env[retired] = previous; });
        process.env[retired] = "256";
        await assert.rejects(Digest.requiem({
            dbPath, digestDir: join(root, "report"),
            provider: new Mock({ contextWindow: 8192, responses: [] }),
            openEvidence: () => { throw new Error("retired configuration must not open evidence"); },
        }), { message: `${retired} is retired: use ${current}` });
    });
}
