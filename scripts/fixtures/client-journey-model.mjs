import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { parseLogRecords } from "../../plurnk-core/test/LogRecords.ts";

const MODEL = "plurnk-installed-journey";

const journeys = Object.freeze({
    cli: {
        marker: "Exercise the installed one-shot interface.",
        programs: [{
            reasoning: "I will complete the installed one-shot request through the shared protocol.",
            content: "````KILL\nThe installed one-shot journey is complete.\n````",
        }],
    },
    tui: {
        marker: "Exercise the installed interactive terminal.",
        programs: [{
            reasoning: "I will complete the request through the interactive terminal.",
            content: [
                "````READ (log:///1/2/1/SEND)````",
                "````READ (worker:///_plurnk/plurnk/worker.md) <1,-1>````",
                "````READ (worker:///_plurnk/plurnk/node.md) <1,-1>````",
                "````READ (skill://plurnk/SKILL.md) <1,-1>````",
                "````READ (skill://plurnk/.env.defaults) <1,16>````",
                "````NOTE <!-- Confirm the packed interactive terminal path. -->\nThe shared protocol is available.\n````",
            ].join("\n"),
        }, {
            reasoning: "The message was retrieved from its log address, so the journey can conclude.",
            content: "````KILL\nThe installed interactive journey is complete.\n````",
        }],
    },
    rejected: {
        marker: "Exercise the rejected provider request.",
        programs: [{
            rejection: "The requested model is unavailable; select an available model.",
        }],
    },
});

const readJson = async (request) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    return JSON.parse(body);
};

const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;

const streamProgram = async (response, journey, program, index) => {
    response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
    });
    const id = `${journey}-${index + 1}`;
    const chunk = (delta, finishReason = null) => ({
        id,
        object: "chat.completion.chunk",
        created: index + 1,
        model: MODEL,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
    response.write(frame(chunk({ reasoning_content: program.reasoning })));
    await delay(10);
    const midpoint = Math.ceil(program.content.length / 2);
    response.write(frame(chunk({ content: program.content.slice(0, midpoint) })));
    await delay(10);
    response.write(frame(chunk({ content: program.content.slice(midpoint) })));
    await delay(10);
    response.write(frame({
        ...chunk({}, "stop"),
        usage: {
            prompt_tokens: 400,
            completion_tokens: 80,
            total_tokens: 480,
            completion_tokens_details: { reasoning_tokens: 12 },
        },
    }));
    response.end("data: [DONE]\n\n");
};

export const startClientJourneyModel = async () => {
    const requests = [];
    const counts = new Map(Object.keys(journeys).map((name) => [name, 0]));
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", "http://fixture.invalid");
            if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
                response.writeHead(404, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
                return;
            }
            const body = await readJson(request);
            const messages = JSON.stringify(body.messages ?? []);
            const matches = Object.entries(journeys)
                .filter(([, { marker }]) => messages.includes(marker));
            if (matches.length !== 1) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "request did not identify exactly one installed journey" } }));
                return;
            }
            const [journey, definition] = matches[0];
            const index = counts.get(journey) ?? 0;
            const program = definition.programs[index];
            const text = (body.messages ?? []).map((message) => typeof message.content === "string" ? message.content : "").join("\n");
            if (journey === "tui" && index === 1) {
                const log = /(?:^|\n)## Log\n([\s\S]*?)(?=\n## |$)/u.exec(text)?.[1]?.trim() ?? "";
                const messageRead = parseLogRecords(log).find((row) =>
                    String(row.logPath).endsWith("/READ") && row.path === "log:///1/2/1/SEND");
                assert.ok(messageRead, "installed TUI must READ its message from the arrival's log address");
                assert.equal(messageRead.status ?? 200, 200, "the message READ succeeded");
                assert.match(String(messageRead.body ?? ""), /^(?:@[0-9A-Za-z]{5} )?\s*1:Exercise the installed interactive terminal\./u,
                    "the READ receipt contains the addressed message, not merely a final success claim");
                for (const witness of [
                    /(?:^|\n)@[0-9A-Za-z]{5} +\d+:```BARE\n@[0-9A-Za-z]{5} +\d+:A self-contained prompt\./u,
                    /(?:^|\n)@[0-9A-Za-z]{5} +\d+:```node <!--/u,
                    /(?:^|\n) *\d+:.*\[Complete \.env\.defaults\]\(\.env\.defaults\)/u,
                    /^### log:\/\/\/\S+\/READ → skill:\/\/plurnk\/\.env\.defaults · \d+$/mu,
                ]) {
                    if (!witness.test(text)) throw new Error(`installed reference READ omitted ${witness}`);
                }
                if (/@[0-9A-Za-z]{5} +\d+:.*\[Complete \.env\.defaults\]\(\.env\.defaults\)/u.test(text)) {
                    throw new Error("installed read-only skill advertised model EDIT anchors");
                }
            }
            requests.push({ journey, body });
            if (program === undefined) {
                response.writeHead(409, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: `unexpected extra ${journey} inference turn` } }));
                return;
            }
            if (body.model !== MODEL || body.stream !== true) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "invalid installed-journey request" } }));
                return;
            }
            counts.set(journey, index + 1);
            if (program.rejection !== undefined) {
                response.writeHead(400, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: program.rejection } }));
                return;
            }
            await streamProgram(response, journey, program, index);
        } catch (error) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: String(error) } }));
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("client-journey fixture did not bind a TCP port");
    }
    return {
        env: {
            PLURNK_MODEL: "journey",
            PLURNK_MODEL_journey: `journey-fixture/${MODEL}`,
            PLURNK_PROVIDERS_PROVIDER_JOURNEY_FIXTURE_NPM: "@ai-sdk/openai-compatible",
            PLURNK_PROVIDERS_PROVIDER_JOURNEY_FIXTURE_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            PLURNK_PROVIDERS_CONTEXT_WINDOW_journey: "32768",
            PLURNK_PROVIDERS_OUTPUT_BUDGET_journey: "4096",
            PLURNK_PROVIDERS_REASONING_journey: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS_journey: "0",
            PLURNK_PROVIDERS_FETCH_TIMEOUT_journey: "5000",
            PLURNK_PROVIDERS_OPERATION_TIMEOUT_journey: "15000",
            PLURNK_PROVIDERS_FIRST_CONTENT_TIMEOUT_journey: "5000",
            PLURNK_PROVIDERS_STREAM_IDLE_TIMEOUT_journey: "5000",
            PLURNK_PROVIDERS_CACHE_AFFINITY_journey: "0",
            PLURNK_PROVIDERS_CACHE_WRITE_POLICY_journey: "off",
        },
        requests,
        assertComplete: () => {
            for (const [name, { programs }] of Object.entries(journeys)) {
                const actual = counts.get(name) ?? 0;
                if (actual !== programs.length) {
                    throw new Error(`${name} journey made ${actual} inference requests instead of ${programs.length}`);
                }
            }
        },
        close: async () => {
            server.close();
            server.closeAllConnections();
            await once(server, "close");
        },
    };
};
