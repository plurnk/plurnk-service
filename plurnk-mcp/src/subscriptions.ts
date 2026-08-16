import {
    type Client,
    type McpSubscription,
    type SubscriptionFilter,
} from "@modelcontextprotocol/client";

const RETRY_FLOOR_MS = 250;
const RETRY_CEILING_MS = 5_000;

export interface SubscriptionOptions {
    readonly timeout: number;
    readonly onError?: (error: Error) => void;
}

const asError = (cause: unknown): Error => cause instanceof Error
    ? cause
    : new Error(String(cause));

const filterFor = (
    client: Client,
    resources: ReadonlySet<string>,
): SubscriptionFilter => {
    const capabilities = client.getDiscoverResult()?.capabilities;
    return {
        ...(capabilities?.tools?.listChanged === true
            ? { toolsListChanged: true }
            : {}),
        ...(capabilities?.prompts?.listChanged === true
            ? { promptsListChanged: true }
            : {}),
        ...(capabilities?.resources?.listChanged === true
            ? { resourcesListChanged: true }
            : {}),
        ...(capabilities?.resources?.subscribe === true && resources.size > 0
            ? { resourceSubscriptions: [...resources].toSorted() }
            : {}),
    };
};

const hasSelections = (filter: SubscriptionFilter): boolean =>
    Object.keys(filter).length > 0;

/** Owns the one current modern subscription filter for a server connection. */
export default class Subscriptions {
    readonly #client: Client;
    readonly #options: SubscriptionOptions;
    readonly #resources = new Set<string>();
    #current: McpSubscription | undefined;
    #work: Promise<void> = Promise.resolve();
    #retryTimer: NodeJS.Timeout | undefined;
    #retryAttempt = 0;
    #listenAbort: AbortController | undefined;
    #closed = false;

    constructor(client: Client, options: SubscriptionOptions) {
        this.#client = client;
        this.#options = options;
        this.#current = client.autoOpenedSubscription;
        if (this.#current === undefined) {
            if (hasSelections(filterFor(client, this.#resources))) this.#scheduleRetry();
        } else {
            this.#observe(this.#current);
        }
    }

    async selectResource(uri: string): Promise<void> {
        if (this.#closed) throw new Error("MCP subscriptions are closed.");
        if (this.#client.getDiscoverResult()?.capabilities.resources?.subscribe !== true) return;
        if (this.#resources.has(uri)) return;
        this.#resources.add(uri);
        this.#clearRetry();
        await this.#enqueueReplacement();
    }

    #enqueueReplacement(): Promise<void> {
        const replacement = this.#work.then(() => this.#replace());
        this.#work = replacement.catch(() => undefined);
        return replacement;
    }

    async #replace(): Promise<void> {
        if (this.#closed) return;
        const filter = filterFor(this.#client, this.#resources);
        if (!hasSelections(filter)) return;

        const prior = this.#current;
        const controller = new AbortController();
        this.#listenAbort = controller;
        let next: McpSubscription;
        try {
            next = await this.#client.listen(filter, {
                timeout: this.#options.timeout,
                signal: controller.signal,
            });
        } catch (cause) {
            if (!this.#closed && !controller.signal.aborted) {
                this.#report(cause);
                this.#scheduleRetry();
            }
            return;
        } finally {
            if (this.#listenAbort === controller) this.#listenAbort = undefined;
        }

        if (this.#closed) {
            await next.close();
            return;
        }
        this.#clearRetry();
        this.#retryAttempt = 0;
        this.#current = next;
        this.#observe(next);
        if (prior !== undefined && prior !== next) {
            try {
                await prior.close();
            } catch (cause) {
                this.#report(cause);
            }
        }
    }

    #observe(subscription: McpSubscription): void {
        void subscription.closed.then((reason) => {
            if (
                this.#closed
                || reason === "local"
                || this.#current !== subscription
            ) return;
            this.#current = undefined;
            this.#scheduleRetry();
        });
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#retryTimer !== undefined) return;
        const delay = Math.min(
            RETRY_FLOOR_MS * (2 ** this.#retryAttempt),
            RETRY_CEILING_MS,
        );
        this.#retryAttempt += 1;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            void this.#enqueueReplacement().catch((cause: unknown) => {
                if (!this.#closed) this.#report(cause);
            });
        }, delay);
        this.#retryTimer.unref();
    }

    #clearRetry(): void {
        if (this.#retryTimer === undefined) return;
        clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
    }

    #report(cause: unknown): void {
        this.#options.onError?.(asError(cause));
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#clearRetry();
        this.#listenAbort?.abort(new Error("MCP subscription manager closed."));
        this.#listenAbort = undefined;
        const current = this.#current;
        this.#current = undefined;
        const closures = [
            ...(current === undefined ? [] : [current.close()]),
            this.#work,
        ];
        const settled = await Promise.allSettled(closures);
        const failures = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, "MCP subscription shutdown failed.");
        }
    }
}
