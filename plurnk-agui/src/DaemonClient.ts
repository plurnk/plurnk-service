// An ordinary client of the plurnk daemon's JSON-RPC-over-WebSocket wire — the same protocol
// the CLI/TUI/nvim clients speak. The bridge holds no state the daemon doesn't (§agui-daemon-client).

export default class DaemonClient {
    #ws: WebSocket;
    #nextId = 1;
    #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    #listeners = new Map<string, Set<(params: unknown) => void>>();

    private constructor(ws: WebSocket) {
        this.#ws = ws;
        ws.addEventListener("message", (ev) => {
            const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown };
            if (typeof msg.id === "number" && this.#pending.has(msg.id)) {
                const waiter = this.#pending.get(msg.id)!;
                this.#pending.delete(msg.id);
                if (msg.error !== undefined) waiter.reject(new Error(msg.error.message));
                else waiter.resolve(msg.result);
                return;
            }
            if (typeof msg.method === "string") {
                for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
            }
        });
    }

    static async connect(url: string): Promise<DaemonClient> {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve, reject) => {
            ws.addEventListener("open", () => resolve(), { once: true });
            ws.addEventListener("error", () => reject(new Error(`plurnk-agui: cannot reach the daemon at ${url} — is plurnk-service running?`)), { once: true });
        });
        return new DaemonClient(ws);
    }

    call<T = unknown>(method: string, params: object = {}): Promise<T> {
        const id = this.#nextId++;
        return new Promise<T>((resolve, reject) => {
            this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            this.#ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });
    }

    on(method: string, fn: (params: unknown) => void): () => void {
        let set = this.#listeners.get(method);
        if (set === undefined) { set = new Set(); this.#listeners.set(method, set); }
        set.add(fn);
        return () => { set.delete(fn); };
    }

    close(): void {
        this.#ws.close();
    }
}
