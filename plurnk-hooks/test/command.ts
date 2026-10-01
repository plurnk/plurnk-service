import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import type { TestContext } from "node:test";

interface ObservedEvent {
    readonly hook_event_name: string;
    readonly plurnk: {
        readonly workspaceId: number | null;
        readonly method: string;
        readonly params: { readonly id: number; readonly text?: string };
    };
}

export const commandFixture = async (t: TestContext) => {
    const events: ObservedEvent[] = [];
    const clients = new Map<number, Socket>();
    const sockets = new Set<Socket>();
    const arrivals = new Map<number, () => void>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        let body = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            body += chunk;
            if (!body.endsWith("\n")) return;
            const event = JSON.parse(body) as ObservedEvent;
            events.push(event);
            clients.set(event.plurnk.params.id, socket);
            arrivals.get(events.length)?.();
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) => server.close((cause) => cause ? reject(cause) : resolve()));
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture server did not bind TCP");
    return {
        env: {
            PLURNK_HOOKS_COMMAND: process.execPath,
            PLURNK_HOOKS_ARGS: JSON.stringify(["--input-type=module", "-e", [
                'import { connect } from "node:net";',
                'let input = ""; process.stdin.setEncoding("utf8");',
                'for await (const chunk of process.stdin) input += chunk;',
                'const socket = connect({ host: "127.0.0.1", port: Number(process.argv[1]) });',
                'socket.on("connect", () => socket.write(input));',
                'for await (const chunk of socket) {}',
            ].join("\n"), String(address.port)]),
            PLURNK_HOOKS_EVENTS: "Stop",
        },
        events,
        waitFor: (count: number): Promise<void> => events.length >= count
            ? Promise.resolve()
            : new Promise((resolve) => arrivals.set(count, resolve)),
        release: (id: number): void => {
            const socket = clients.get(id);
            if (socket === undefined) throw new Error(`hook ${id} has not arrived`);
            socket.end();
        },
    };
};
