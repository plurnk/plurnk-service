import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const MODEL = "plurnk-installed-journey";

const journeys = Object.freeze({
    cli: {
        marker: "Exercise the installed one-shot interface.",
        programs: [{
            reasoning: "I will complete the installed one-shot request through the shared protocol.",
            content: "```SEND\nThe installed one-shot journey is complete.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```",
        }],
    },
    tui: {
        marker: "Exercise the installed interactive terminal.",
        programs: [{
            reasoning: "I will complete the request through the interactive terminal.",
            content: [
                "````READ (prompt:///1/1)````",
                "````READ (worker://~/_plurnk/plurnk/worker.md) <1,-1>````",
                "````READ (worker://~/_plurnk/plurnk/node.md) <1,-1>````",
                "````READ (skill://plurnk/SKILL.md) <1,-1>````",
                "````READ (skill://plurnk/.env.defaults) <1,16>````",
                "````TASK\n[{\"content\":\"Confirm the packed interactive terminal path.\",\"status\":\"in_progress\"}]\n````",
            ].join("\n"),
        }, {
            reasoning: "The prompt was retrieved through the terminal, so the journey can conclude.",
            content: "```SEND\nThe installed interactive journey is complete.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```",
        }],
    },
    rejected: {
        marker: "Exercise the rejected provider request.",
        programs: [{
            rejection: "The requested model is unavailable; select an available model.",
        }],
    },
    nvim: {
        marker: "Create a reviewed acceptance marker.",
        programs: [
            {
                reasoning: "I will make one reviewed local change, then verify the settled result.",
                content: "```EXEC\nprintf 'accepted\\n' > journey.txt\n```\n```TASK\n[{\"content\":\"Create the requested acceptance marker through review.\",\"status\":\"in_progress\"}]\n```",
            },
            {
                reasoning: "The reviewed command succeeded, so I can conclude the requested journey.",
                content: "```SEND\nThe reviewed multiline journey is complete.\n```\n```TASK\n[{\"content\":\"Create the requested acceptance marker through review.\",\"status\":\"completed\"}]\n```",
            },
            {
                reasoning: "I will ask for the named fields and await the answer.",
                content: [
                    "```question (question)",
                    JSON.stringify({ message: "Which branch details?", requestedSchema: {
                        type: "object", properties: {
                            branch: { type: "string" }, count: { type: "integer" }, notes: { type: "string" },
                        }, required: ["count"],
                    } }),
                    "```", "```TASK", '[{"content":"Awaiting branch details.","status":"waiting"}]', "```",
                ].join("\n"),
            },
            {
                reasoning: "The question result has arrived in the continued loop.",
                content: "```SEND\nThe named-field answer arrived.\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```",
            },
        ],
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
                for (const witness of [
                    /(?:^|\n) *\d+:````WORK \(worker:\/\/capital-checker\)/u,
                    /(?:^|\n) *\d+:````node <!--/u,
                    /(?:^|\n) *\d+:.*\[Complete \.env\.defaults\]\(\.env\.defaults\)/u,
                    /"target":"skill:\/\/plurnk\/\.env\.defaults"/u,
                ]) {
                    if (!witness.test(text)) throw new Error(`installed reference READ omitted ${witness}`);
                }
                if (/@[0-9A-Za-z]{5} +\d+:````(?:WORK|node)/u.test(text)) {
                    throw new Error("installed read-only teaching advertised model EDIT anchors");
                }
            }
            if (journey === "nvim" && index === 3
                && (!text.includes("typed-through-nvim") || !/"count"\s*:\s*0\b/u.test(text))) {
                throw new Error("the Neovim continuation did not carry the named-field answer");
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
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
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
