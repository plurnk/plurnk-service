import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import type { McpHttpHandler } from "@modelcontextprotocol/server";

export interface ReceivedRequest {
    readonly headers: Headers;
    readonly body: unknown;
}

const requestBody = async (request: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
};

const writeResponse = async (response: Response, target: ServerResponse): Promise<void> => {
    target.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
        target.end();
        return;
    }
    const reader = response.body.getReader();
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        target.write(Buffer.from(value));
    }
    target.end();
};

export const serveMcpHttp = async (
    t: TestContext,
    handler: McpHttpHandler,
    route: (request: Request) => Response | null | Promise<Response | null> = () => null,
): Promise<{ url: string; requests: ReceivedRequest[] }> => {
    const requests: ReceivedRequest[] = [];
    const server = createServer((incoming, outgoing) => {
        void (async () => {
            const body = await requestBody(incoming);
            const controller = new AbortController();
            const abort = (): void => {
                if (!controller.signal.aborted) {
                    controller.abort(new Error("HTTP test client disconnected."));
                }
            };
            incoming.once("aborted", abort);
            outgoing.once("close", () => {
                if (!outgoing.writableEnded) abort();
            });
            const request = new Request(
                new URL(incoming.url ?? "/", `http://${incoming.headers.host}`).href,
                {
                    method: incoming.method,
                    headers: incoming.headers as HeadersInit,
                    signal: controller.signal,
                    ...(body.length === 0 ? {} : { body: body.toString("utf8") }),
                },
            );
            let parsed: unknown = null;
            if (body.length > 0) {
                parsed = request.headers.get("content-type")?.startsWith("application/json") === true
                    ? JSON.parse(body.toString("utf8"))
                    : body.toString("utf8");
            }
            requests.push({ headers: request.headers, body: parsed });
            const routed = await route(request);
            await writeResponse(routed ?? await handler.fetch(request), outgoing);
        })().catch((cause: unknown) => {
            outgoing.destroy(cause instanceof Error ? cause : new Error(String(cause)));
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    t.after(async () => {
        await handler.close();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error === undefined) resolve();
                else reject(error);
            });
        });
    });
    return { url: `http://127.0.0.1:${port}/mcp`, requests };
};
