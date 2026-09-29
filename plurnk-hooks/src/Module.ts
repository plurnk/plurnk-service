import { spawn } from "node:child_process";
import type { ApplicationPort } from "@plurnk/plurnk-contracts";
import { hookConfig, type HookConfig } from "./config.ts";

interface Delivery {
    readonly method: string;
    readonly input: string;
    readonly deadline: number;
}

export interface ModuleOptions {
    readonly report?: (message: string, cause: unknown) => void;
}

export default class Module {
    readonly #config: HookConfig | null;
    readonly #environment: NodeJS.ProcessEnv;
    readonly #report: (message: string, cause: unknown) => void;
    readonly #active = new Set<Promise<void>>();
    readonly #queued: Delivery[] = [];
    #unsubscribe: (() => void) | null = null;
    #started = false;
    #closing: Promise<void> | null = null;

    static init(options: ModuleOptions = {}): Module {
        return new Module(
            hookConfig(),
            { ...process.env },
            options.report ?? ((message, cause) => { console.error(`${message}:`, cause); }),
        );
    }

    private constructor(config: HookConfig | null, environment: NodeJS.ProcessEnv, report: (message: string, cause: unknown) => void) {
        this.#config = config;
        this.#environment = environment;
        this.#report = report;
    }

    start(seam: Pick<ApplicationPort, "subscribeToEvents">): void {
        if (this.#started || this.#closing !== null) throw new Error("hooks module cannot be started again");
        this.#started = true;
        if (this.#config === null) return;
        this.#unsubscribe = seam.subscribeToEvents((workspaceId, method, params) => {
            if (!this.#config?.events.has(method)) return;
            if (this.#active.size >= this.#config.concurrency && this.#queued.length >= this.#config.queueLimit) {
                this.#failed(method, new Error("Hook delivery queue is full; event not delivered."));
                return;
            }
            try {
                this.#queued.push({ method, input: `${JSON.stringify({ workspaceId, method, params })}\n`, deadline: Date.now() + this.#config.timeoutMs });
                this.#pump();
            } catch (cause) { this.#failed(method, cause); }
        });
    }

    close(): Promise<void> {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#closing ??= this.#drain();
        return this.#closing;
    }

    async #drain(): Promise<void> {
        while (this.#active.size > 0) await Promise.all(this.#active);
    }

    #failed(method: string, cause: unknown): void {
        try { this.#report(`hook command failed for ${method}`, cause); }
        catch (reportCause) { console.error(`hook failure reporter failed for ${method}:`, new AggregateError([cause, reportCause])); }
    }

    #pump(): void {
        const config = this.#config;
        if (config === null) return;
        while (this.#queued.length > 0 && this.#active.size < config.concurrency) {
            const delivery = this.#queued.shift()!;
            const remaining = delivery.deadline - Date.now();
            if (remaining <= 0) {
                this.#failed(delivery.method, new Error("Hook delivery deadline expired in queue; event not delivered."));
                continue;
            }
            let observed: Promise<void>;
            observed = this.#deliver(delivery.input, remaining)
                .catch((cause: unknown) => { this.#failed(delivery.method, cause); })
                .finally(() => { this.#active.delete(observed); this.#pump(); });
            this.#active.add(observed);
        }
    }

    async #deliver(input: string, timeoutMs: number): Promise<void> {
        const config = this.#config;
        if (config === null) return;
        await new Promise<void>((resolve, reject) => {
            const failures: Error[] = [];
            const child = spawn(config.command, config.args, {
                shell: false,
                env: this.#environment,
                stdio: ["pipe", "inherit", "inherit"],
                signal: AbortSignal.timeout(timeoutMs),
                killSignal: "SIGKILL",
            });
            child.once("error", (cause) => { failures.push(cause); });
            child.once("close", (code, signal) => {
                if (failures.length > 1) reject(new AggregateError(failures, "Hook delivery failed."));
                else if (failures.length === 1) reject(failures[0]);
                else if (code === 0) resolve();
                else reject(new Error(
                    signal === null
                        ? `hook command exited with status ${String(code)}`
                        : `hook command exited on ${signal}`,
                ));
            });
            child.stdin.once("error", (cause) => {
                failures.push(cause);
                child.kill("SIGKILL");
            });
            child.stdin.end(input, "utf8");
        });
    }
}
