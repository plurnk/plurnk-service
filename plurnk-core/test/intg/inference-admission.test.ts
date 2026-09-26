import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout } from "node:timers/promises";
import { instantiateProvider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import { connect, rpcCall, runLoopToTerminal, withDaemon } from "./_rpc.ts";

for (const delegated of ["WORK", "BARE"] as const) {
    test(`{§provider-inference-admission} a single inference slot completes ${delegated} through the daemon lifecycle`, { timeout: 20000 }, async (t) => {
        const parentModel = "gpt-4.1-mini";
        const childModel = "gpt-4.1-nano";
        const requests: string[] = [];
        let active = 0;
        let peak = 0;
        let parentTurns = 0;
        const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += chunk;
            const { model } = JSON.parse(body) as { model: string };
            requests.push(model);
            active += 1;
            peak = Math.max(peak, active);
            const content = model === childModel
                ? delegated === "BARE" ? "42" : "````KILL\nchild complete\n````"
                : parentTurns++ === 0
                    ? delegated === "BARE"
                        ? "````BARE\nWhat is six times seven?\n````"
                        : "````WORK (worker://first)\nComplete your task.\n````\n\n````WORK (worker://second)\nComplete your task.\n````\n\n````WAIT\n````"
                    : "````KILL\nDelegated results received.\n````";
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(`data: ${JSON.stringify({
                id: String(requests.length), object: "chat.completion.chunk", created: 1, model,
                choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`);
            await setTimeout(25);
            active -= 1;
            response.end(`data: ${JSON.stringify({
                id: String(requests.length), object: "chat.completion.chunk", created: 1, model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            })}\n\ndata: [DONE]\n\n`);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        const routes = await Promise.all([parentModel, childModel].map(async (model) => {
            const spec = { alias: `admission-${crypto.randomUUID()}`, provider: "openai", model, baseUrl };
            const declaration = {
                [`PLURNK_MODEL_${spec.alias}`]: `openai/${model}`,
                [`PLURNK_BASEURL_${spec.alias}`]: baseUrl,
                [`PLURNK_PROVIDERS_REASONING_${spec.alias}`]: "off",
                [`PLURNK_PROVIDERS_MAX_CONCURRENCY_${spec.alias}`]: "1",
            };
            Object.assign(process.env, declaration);
            t.after(() => { for (const key of Object.keys(declaration)) delete process.env[key]; });
            const provider = await instantiateProvider("openai", {
                ...process.env,
                OPENAI_API_KEY: "fixture-key",
                PLURNK_PROVIDERS_REASONING: "off",
                PLURNK_PROVIDERS_MAX_CONCURRENCY: "1",
            }, model, undefined, undefined, baseUrl);
            ProviderInstantiate.registerInstance(provider, spec);
            return spec;
        }));
        await withDaemon(null, async (db, _daemon, address) => {
            const client = await connect(address);
            try {
                await rpcCall(client, 1, "workspace.create", { name: `admission-${crypto.randomUUID()}` });
                const result = await runLoopToTerminal(client, 2, {
                    prompt: "Complete the delegated work and report the result.",
                    selector: routes[0]!.alias,
                    childSelector: routes[1]!.alias,
                    policy: { proposals: "accept" },
                }, { timeoutMs: 12000 });
                assert.equal(result.finalStatus, 200);
                assert.equal(peak, 1, "separate parent and child provider handles share the physical slot");
                assert.equal(requests.filter((model) => model === childModel).length, delegated === "BARE" ? 1 : 2);
                const loops = await db.test_all_loops.all<{ model_route_id: number | null; status: number }>({});
                const modelLoops = loops.filter(({ model_route_id }) => model_route_id !== null);
                assert.equal(modelLoops.length, delegated === "BARE" ? 1 : 3);
                assert.ok(modelLoops.every(({ status }) => status === 200), "parent and every real child settle successfully");
                if (delegated === "BARE") {
                    const rows = await db.test_log_entries_by_loop.all<{ op: string | null; rx: string }>({ loop_id: result.loopId });
                    assert.equal(JSON.parse(rows.find(({ op }) => op === "BARE")!.rx).content, "42");
                }
            } finally {
                client.close();
            }
        });
    });
}
