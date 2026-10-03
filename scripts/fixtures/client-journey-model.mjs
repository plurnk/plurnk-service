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
                "````READ (worker:///_plurnk/plurnk/pattern.md) ~quotes````",
                "````READ (worker:///_plurnk/plurnk/delegation.md) <1,16>````",
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
    recovery: {
        marker: "Exercise the failed stream finalization.",
        programs: [{
            reasoning: "The stream will finish before its durable close can commit.",
            content: "````sh\nprintf 'retained-stream-output\\n'\n````\n\n````WAIT\nAwait the command.\n````",
        }, {
            reasoning: "The additional message reached the parked worker.",
            content: "````NOTE <!-- Follow-up accepted while parked. -->\nThe unresolved stream remains an obligation.\n````\n\n````WAIT\nAwait settlement.\n````",
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
    // A failed witness answers 500 and is kept here, so a timeout upstream can name it (#896).
    const errors = [];
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url ?? "/", "http://fixture.invalid");
            if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
                response.writeHead(404, { "content-type": "application/json" });
                response.end(JSON.stringify({ error: { message: "fixture route not found" } }));
                return;
            }
            const body = await readJson(request);
            if (body.reasoning?.max_tokens !== undefined) {
                assert.ok(Number.isSafeInteger(body.reasoning.max_tokens) && body.reasoning.max_tokens > 0);
                assert.ok(body.reasoning.max_tokens < body.max_tokens, "reasoning fits within the fixture's total output ceiling");
            }
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
            // {§packet-wire-envelope}: the packet is the system and user messages; the assistant messages are the worker's emissions.
            const text = (body.messages ?? []).filter((message) => message.role !== "assistant").map((message) => typeof message.content === "string" ? message.content : "").join("\n\n");
            if (journey === "recovery" && index === 1) {
                assert.ok(text.includes("Please keep observing the unresolved stream."), "new input wakes the parked worker");
                assert.ok(text.includes("retained-stream-output"), "the next packet retains the producer's output");
            }
            if (journey === "tui" && index === 1) {
                const log = /(?:^|\n)## Log\n([\s\S]*?)(?=\n## |$)/u.exec(text)?.[1]?.trim() ?? "";
                const records = parseLogRecords(log);
                const messageRead = records.find((row) =>
                    String(row.logPath).endsWith("/READ") && row.path === "log:///1/2/1/SEND");
                assert.ok(messageRead, "installed TUI must READ its message from the arrival's log address");
                assert.equal(messageRead.status ?? 200, 200, "the message READ succeeded");
                assert.match(String(messageRead.body ?? ""), /^ *1(?:<@[0-9A-Za-z]{5}>|:)Exercise the installed interactive terminal\./u,
                    "the READ receipt contains the addressed message, not merely a final success claim");
                // {§read-pattern-evidence} {§teaching-corpus}: packed references and indexed READ compose.
                const patternRead = records.find((row) =>
                    String(row.logPath).endsWith("/READ") && row.path === "worker:///_plurnk/plurnk/pattern.md");
                assert.ok(patternRead, "the installed runtime exposes the pattern reference");
                assert.equal(patternRead.status ?? 200, 200);
                assert.equal(patternRead.matcher, "~quotes");
                assert.match(String(patternRead.body ?? ""), /quotes and escapes, not the property name or colon\./u,
                    "full-text READ returns the selected source line from the installed reference");
                assert.ok(Array.isArray(patternRead.matches) && patternRead.matches.length > 0);
                assert.ok(patternRead.matches.every(({ region }) => typeof region === "string"),
                    "the installed packet retains precise match locations beside whole source lines");
                const delegationRead = records.find((row) =>
                    String(row.logPath).endsWith("/READ") && row.path === "worker:///_plurnk/plurnk/delegation.md");
                assert.ok(delegationRead, "the installed runtime exposes the delegation reference");
                assert.equal(delegationRead.status ?? 200, 200);
                assert.match(String(delegationRead.body ?? ""), /WORK starts a fresh log/u);
                for (const witness of [
                    /(?:^|\n) *\d+<@[0-9A-Za-z]{5}>```BARE\n *\d+<@[0-9A-Za-z]{5}>A self-contained prompt, with everything it needs pasted in\./u,
                    /(?:^|\n) *\d+<@[0-9A-Za-z]{5}>```node <!--/u,
                    /(?:^|\n) *\d+:.*\[Complete \.env\.defaults\]\(\.env\.defaults\)/u,
                    /^### log:\/\/\/\S+\/READ → skill:\/\/plurnk\/\.env\.defaults · \d+$/mu,
                ]) {
                    if (!witness.test(text)) throw new Error(`installed reference READ omitted ${witness}`);
                }
                if (/\d+<@[0-9A-Za-z]{5}>.*\[Complete \.env\.defaults\]\(\.env\.defaults\)/u.test(text)) {
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
            errors.push(String(error));
            process.stderr.write(`client-journey fixture: ${String(error)}\n`);
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
            PLURNK_PROVIDERS_PROVIDER_JOURNEY_FIXTURE_REASONING_BUDGET_PATH: "/reasoning/max_tokens",
            PLURNK_PROVIDERS_CONTEXT_WINDOW_journey: "32768",
            PLURNK_PROVIDERS_OUTPUT_BUDGET_journey: "4096",
            PLURNK_PROVIDERS_EFFORT_journey: "adaptive",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS_journey: "0",
            PLURNK_PROVIDERS_FETCH_TIMEOUT_journey: "5000",
            PLURNK_PROVIDERS_OPERATION_TIMEOUT_journey: "15000",
            PLURNK_PROVIDERS_CACHE_AFFINITY_journey: "0",
            PLURNK_PROVIDERS_CACHE_WRITE_POLICY_journey: "off",
        },
        requests,
        errors,
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
