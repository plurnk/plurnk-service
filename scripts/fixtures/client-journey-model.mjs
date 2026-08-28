import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const MODEL = "plurnk-installed-journey";

const journeys = Object.freeze({
    cli: {
        marker: "Exercise the installed one-shot interface.",
        programs: [{
            reasoning: "I will complete the installed one-shot request through the shared protocol.",
            content: [
                "# PLAN0",
                '[{"content":"Confirm the packed one-shot client path.","priority":"high","status":"completed"}]',
                "## SEND0 [200]",
                "The installed one-shot journey is complete.",
            ].join("\n"),
        }],
    },
    tui: {
        marker: "Exercise the installed interactive terminal.",
        programs: [{
            reasoning: "I will complete the request through the interactive terminal.",
            content: [
                "# PLAN0",
                '[{"content":"Confirm the packed interactive terminal path.","priority":"high","status":"completed"}]',
                "## SEND0 [200]",
                "The installed interactive journey is complete.",
            ].join("\n"),
        }],
    },
    nvim: {
        marker: "Create a reviewed acceptance marker.",
        programs: [
            {
                reasoning: "I will make one reviewed local change, then verify the settled result.",
                content: [
                    "# PLAN0",
                    '[{"content":"Create the requested acceptance marker through review.","priority":"high","status":"in_progress"}]',
                    "## EXEC0 [sh]",
                    "printf 'accepted\\n' > journey.txt",
                    "## SEND0 [102]",
                    "Next: Confirm the reviewed command completed.",
                ].join("\n"),
            },
            {
                reasoning: "The reviewed command succeeded, so I can conclude the requested journey.",
                content: [
                    "# PLAN0",
                    '[{"content":"Create the requested acceptance marker through review.","priority":"high","status":"completed"}]',
                    "## SEND0 [200]",
                    "The reviewed multiline journey is complete.",
                ].join("\n"),
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
