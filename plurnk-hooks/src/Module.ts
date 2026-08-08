import { spawn } from "node:child_process";
import { hookConfig, type HookConfig, type HookEvent } from "./config.ts";

interface HooksSeam {
    subscribeToEvents(
        handler: (workspaceId: number | null, method: string, params: unknown) => void,
    ): () => void;
}

export interface ModuleOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly report?: (message: string, cause: unknown) => void;
}

export default class Module {
    readonly #config: HookConfig | null;
    readonly #report: (message: string, cause: unknown) => void;
    readonly #active = new Set<Promise<void>>();
    #unsubscribe: (() => void) | null = null;
    #started = false;

    static init(options: ModuleOptions = {}): Module {
        return new Module(
            hookConfig(options.env ?? process.env),
            options.report ?? ((message, cause) => { console.error(`${message}:`, cause); }),
        );
    }

    private constructor(config: HookConfig | null, report: (message: string, cause: unknown) => void) {
        this.#config = config;
        this.#report = report;
    }

    start(seam: HooksSeam): void {
        if (this.#started) throw new Error("hooks module already started");
        this.#started = true;
        if (this.#config === null) return;
        this.#unsubscribe = seam.subscribeToEvents((workspaceId, method, params) => {
            if (!this.#config?.events.has(method as HookEvent)) return;
            let observed: Promise<void>;
            observed = this.#deliver({ workspaceId, method, params })
                .catch((cause: unknown) => {
                    try {
                        this.#report(`hook command failed for ${method}`, cause);
                    } catch (reportCause) {
                        console.error(`hook failure reporter failed for ${method}:`, reportCause);
                    }
                })
                .finally(() => { this.#active.delete(observed); });
            this.#active.add(observed);
        });
    }

    async close(): Promise<void> {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        await Promise.all(this.#active);
    }

    #deliver(envelope: { workspaceId: number | null; method: string; params: unknown }): Promise<void> {
        const config = this.#config;
        if (config === null) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
            const child = spawn(config.command, config.args, {
                shell: false,
                stdio: ["pipe", "inherit", "inherit"],
                signal: AbortSignal.timeout(config.timeoutMs),
                killSignal: "SIGKILL",
            });
            child.once("error", reject);
            child.once("close", (code, signal) => {
                if (code === 0) resolve();
                else reject(new Error(
                    signal === null
                        ? `hook command exited with status ${String(code)}`
                        : `hook command exited on ${signal}`,
                ));
            });
            child.stdin.once("error", reject);
            child.stdin.end(`${JSON.stringify(envelope)}\n`, "utf8");
        });
    }
}
