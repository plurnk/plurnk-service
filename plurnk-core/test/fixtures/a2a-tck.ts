// Real Core + exterior adapter; only inference is deterministic. No reference TaskStore.
import { Module as A2aModule } from "@plurnk/plurnk-a2a";
import { Mock, type Provider } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { a2aCard } from "../intg/_a2a.ts";
import { openMigrated } from "../intg/_helpers.ts";
import { makeMockResponse } from "../intg/_rpc.ts";

class TckProvider extends Mock {
    readonly #calls = new Map<string, number>();

    constructor() {
        super({ contextWindow: 1_000_000, responses: [] });
    }

    override async generate(args: Parameters<Provider["generate"]>[0]) {
        const count = this.#calls.get(args.workerId) ?? 0;
        this.#calls.set(args.workerId, count + 1);
        const source = JSON.stringify(args.messages);
        const scenario = [...source.matchAll(/\/messages\/(tck-[a-z0-9_-]+)/g)].at(-1)?.[1] ?? "default";
        process.stderr.write(`${JSON.stringify({ scenario, call: count + 1 })}\n`);
        if (scenario.startsWith("tck-artifact-file") && !scenario.startsWith("tck-artifact-file-url")) {
            const content = count === 0
                ? ["```EDIT (worker:///output.txt)", "tck", "```", "```NOTE", "Send the file.", "```"].join("\n")
                : ["```SEND [{\"attachments\":[\"worker:///output.txt\"]}]", "```", "```DONE", "```"].join("\n");
            return new Mock({ contextWindow: 1_000_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
        }
        const awaitingInput = scenario.startsWith("tck-input-required") && (count === 0
            || (source.includes("TCK history message") && !source.includes("TCK complete after history")));
        const content = awaitingInput
            ? [
                "```question",
                JSON.stringify({ message: "Please provide the requested input.", requestedSchema: { type: "string" } }),
                "```",
                "```WAIT",
                "Await the caller's input.",
                "```",
            ].join("\n")
            : [
                "```SEND", scenario.startsWith("tck-artifact-text") ? "Generated text content" : "Hello from TCK", "```",
                "```DONE", "```",
            ].join("\n");
        return new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse(content)] }).generate(args);
    }
}

const db = await openMigrated(process.argv[2]);
const daemon = new Daemon({ db, provider: new TckProvider() });
let baseUrl = "";
daemon.registerModule({
    start: async (port) => {
        const adapter = await A2aModule.init({
            workspace: { name: "a2a-tck", projectRoot: null },
            card: a2aCard(),
        }).start(port);
        const address = adapter.address();
        baseUrl = `http://${address.host}:${address.port}`;
        return adapter;
    },
});
const stopped = Promise.withResolvers<void>();
process.once("SIGTERM", () => stopped.resolve());
process.once("SIGINT", () => stopped.resolve());
process.once("disconnect", () => stopped.resolve());
try {
    await daemon.start();
    if (process.send) process.send({ baseUrl });
    else process.stdout.write(`${baseUrl}\n`);
    await stopped.promise;
} finally {
    await daemon.stop();
    await db.close();
    if (process.connected) process.disconnect?.();
}
