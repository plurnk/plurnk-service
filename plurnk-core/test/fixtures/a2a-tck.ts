// Real Core + exterior adapter; only inference is deterministic. No reference TaskStore.
import { Module as A2aModule } from "@plurnk/plurnk-a2a";
import { Mock, type Provider } from "@plurnk/plurnk-providers";
import Daemon from "../../src/server/Daemon.ts";
import { A2A_EXPOSURE, a2aCard, bindListener, serviceUrl } from "../intg/_a2a.ts";
import { openMigrated } from "../intg/_helpers.ts";
import { makeMockResponse } from "../intg/_rpc.ts";

const WORKSPACE = "a2a-tck";

class TckProvider extends Mock {
    readonly #calls = new Map<string, number>();
    readonly #workers = new Map<string, { workspaceId: number; workerId: number }>();
    readonly #daemon: () => Daemon;
    readonly #db: Awaited<ReturnType<typeof openMigrated>>;

    constructor(db: Awaited<ReturnType<typeof openMigrated>>, daemon: () => Daemon) {
        super({ contextWindow: 1_000_000, responses: [] });
        this.#db = db;
        this.#daemon = daemon;
    }

    // {§message-short-identity} — the packet shows a message by its short address, never the
    // transport's own name for it, so the scenario the TCK encodes in its messageId is read from
    // the durable inbound message of the Task worker this call serves ({§worker-provider-identity}).
    async #scenario(providerIdentity: string): Promise<string> {
        const daemon = this.#daemon();
        let worker = this.#workers.get(providerIdentity);
        if (worker === undefined) {
            const workspace = (await daemon.listWorkspaces()).find(({ name }) => name === WORKSPACE);
            if (workspace === undefined) throw new Error(`inference before the ${WORKSPACE} workspace exists`);
            for (const { id } of await daemon.listWorkers(workspace.id, { origin: "model" })) {
                const identity = await this.#db.engine_worker_provider_identity.get<{ worker_id: string }>({ worker_id: id });
                if (identity?.worker_id === providerIdentity) worker = { workspaceId: workspace.id, workerId: id };
            }
            if (worker === undefined) throw new Error(`no ${WORKSPACE} worker has provider identity ${providerIdentity}`);
            this.#workers.set(providerIdentity, worker);
        }
        const arrivals = (await daemon.readMessages(worker)).filter(({ direction }) => direction === "inbound");
        const source = arrivals.at(-1)?.source ?? "";
        return /\/messages\/(tck-[a-z0-9_-]+)/u.exec(source)?.[1] ?? "default";
    }

    override async generate(args: Parameters<Provider["generate"]>[0]) {
        const count = this.#calls.get(args.workerId) ?? 0;
        this.#calls.set(args.workerId, count + 1);
        const source = JSON.stringify(args.messages);
        const scenario = await this.#scenario(args.workerId);
        process.stderr.write(`${JSON.stringify({ scenario, call: count + 1 })}\n`);
        if (scenario.startsWith("tck-artifact-file") && !scenario.startsWith("tck-artifact-file-url")) {
            const content = count === 0
                ? ["````EDIT (worker:///output.txt)", "tck", "````", "````NOTE", "Send the file.", "````"].join("\n")
                : ["````SEND [{\"attachments\":[\"worker:///output.txt\"]}]", "````", "````SEND", "````"].join("\n");
            return new Mock({ contextWindow: 1_000_000, responses: [{ assistant: { content, reasoning: null } }] }).generate(args);
        }
        const awaitingInput = scenario.startsWith("tck-input-required") && (count === 0
            || (source.includes("TCK history message") && !source.includes("TCK complete after history")));
        const content = awaitingInput
            ? [
                "````question",
                JSON.stringify({ message: "Please provide the requested input.", requestedSchema: { type: "string" } }),
                "````",
                "````WAIT",
                "Await the caller's input.",
                "````",
            ].join("\n")
            : [
                "````SEND", scenario.startsWith("tck-artifact-text") ? "Generated text content" : "Hello from TCK", "````",
                "````SEND", "````",
            ].join("\n");
        return new Mock({ contextWindow: 1_000_000, responses: [makeMockResponse(content)] }).generate(args);
    }
}

const db = await openMigrated(process.argv[2]);
const http = await bindListener();
const daemon = new Daemon({ db, provider: new TckProvider(db, () => daemon), http });
let baseUrl = "";
daemon.registerModule({
    start: async (port) => {
        const adapter = await A2aModule.init({
            workspace: { name: WORKSPACE, projectRoot: null },
            card: a2aCard(),
            ...A2A_EXPOSURE,
        }).start(port);
        baseUrl = serviceUrl(port);
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
    await http.close();
    await db.close();
    if (process.connected) process.disconnect?.();
}
