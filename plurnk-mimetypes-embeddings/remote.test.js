// Remote /v1/embeddings mode (plurnk-mimetypes#46). Mode is resolved at module
// load, so every case runs index.js in a CHILD with the env set, against a real
// ephemeral OpenAI-compatible endpoint served by this test. Children run ASYNC
// (execFile, not execFileSync) — a sync child would block this process's event
// loop and deadlock the very server the child is calling.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const pexec = promisify(execFile);
const indexPath = path.join(import.meta.dirname, "index.js");
const DIM = 8;

let server;
let baseUrl;
const requests = [];

before(async () => {
    server = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
            const body = JSON.parse(raw);
            requests.push({ url: req.url, auth: req.headers.authorization ?? null, body });
            if (req.url === "/broken/embeddings") {
                res.writeHead(500).end("boom");
                return;
            }
            const inputs = Array.isArray(body.input) ? body.input : [body.input];
            // Deterministic fake vectors: v[0] = text length, rest zeros.
            const data = inputs.map((text, index) => ({
                index,
                embedding: [text.length, ...new Array(DIM - 1).fill(0)],
            }));
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});
after(() => server.close());

// Run a snippet importing index.js in remote mode; resolves to stdout.
async function inRemote(snippet, envExtra = {}) {
    const env = { ...process.env, PLURNK_MIMETYPES_EMBED_BASE_URL: baseUrl, PLURNK_MIMETYPES_EMBED_MODEL: "test-model", ...envExtra };
    delete env.PLURNK_MIMETYPES_EMBED_WORKERS; // remote must not require it
    const src = `import * as e from ${JSON.stringify(indexPath)};\n${snippet}`;
    const { stdout } = await pexec(process.execPath, ["--input-type=module", "--eval", src], { env, timeout: 30000 });
    return stdout;
}

describe("remote mode (#46)", () => {
    it("probes the dimension at load and folds model+dimension into the identity", async () => {
        const out = await inRemote(`console.log(JSON.stringify({ d: e.dimension, m: e.model, cw: e.contextWindow ?? null }));`);
        assert.deepEqual(JSON.parse(out), { d: DIM, m: `remote:test-model@d${DIM}`, cw: null });
    });

    it("embed() returns 4×dimension bytes from the endpoint; API key rides as Bearer", async () => {
        const out = await inRemote(
            `const v = await e.embed("hello");\n`
            + `console.log(JSON.stringify({ len: v.byteLength, first: new Float32Array(v.buffer)[0] }));`,
            { PLURNK_MIMETYPES_EMBED_API_KEY: "sekrit" },
        );
        assert.deepEqual(JSON.parse(out), { len: 4 * DIM, first: 5 });
        const authed = requests.find((r) => r.auth === "Bearer sekrit");
        assert.ok(authed, "expected a request carrying the Bearer key");
    });

    it("embedBatch() sends ONE request with the whole input array, in input order", async () => {
        const mark = requests.length;
        const out = await inRemote(
            `let prog = null;\n`
            + `const vs = await e.embedBatch(["a", "bbb", "cc"], { onProgress: (p) => { prog = p; } });\n`
            + `console.log(JSON.stringify({ firsts: vs.map((v) => new Float32Array(v.buffer)[0]), prog }));`,
        );
        assert.deepEqual(JSON.parse(out), { firsts: [1, 3, 2], prog: { completed: 3, total: 3 } });
        const batchReqs = requests.slice(mark).filter((r) => Array.isArray(r.body.input) && r.body.input.length === 3);
        assert.equal(batchReqs.length, 1, "one request for the whole batch");
        assert.equal(batchReqs[0].body.model, "test-model");
    });

    it("BASE_URL without MODEL crashes at load — never guesses", async () => {
        await assert.rejects(
            () => inRemote(`console.log("loaded");`, { PLURNK_MIMETYPES_EMBED_MODEL: "" }),
            /PLURNK_MIMETYPES_EMBED_MODEL is required/,
        );
    });

    it("an unreachable endpoint crashes the import (boot-time surfacing, not mid-query)", async () => {
        await assert.rejects(() => inRemote(`console.log("loaded");`, { PLURNK_MIMETYPES_EMBED_BASE_URL: "http://127.0.0.1:9/v1" }));
    });

    it("a 5xx endpoint names itself in the thrown error", async () => {
        await assert.rejects(
            () => inRemote(`console.log("loaded");`, { PLURNK_MIMETYPES_EMBED_BASE_URL: baseUrl.replace("/v1", "/broken") }),
            /remote embeddings: 500/,
        );
    });


});

describe("remote mode — embedderInfo contract facts (#50)", () => {
    it("countTokens is UNDEFINED (absent), never a throwing decoy", async () => {
        const out = await inRemote(`console.log(JSON.stringify(typeof e.countTokens));`);
        assert.equal(JSON.parse(out), "undefined");
    });
    it("PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW declares the window (operator fact)", async () => {
        const out = await inRemote(
            `console.log(JSON.stringify({ cw: e.contextWindow ?? null }));`,
            { PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW: "8192" },
        );
        assert.deepEqual(JSON.parse(out), { cw: 8192 });
    });
    it("a malformed window crashes; unset stays unknown", async () => {
        await assert.rejects(
            () => inRemote(`console.log("loaded");`, { PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW: "lots" }),
            /must be a positive integer/,
        );
        const out = await inRemote(`console.log(JSON.stringify(e.contextWindow ?? null));`);
        assert.equal(JSON.parse(out), null);
    });
});
