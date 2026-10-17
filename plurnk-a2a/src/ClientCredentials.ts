// {§a2a-outbound-credentials} — OAuth 2.0 client credentials at a remote agent's token endpoint
// (RFC 6749 §4.4): one access token per attachment, obtained at preparation, presented as the bearer
// on every request, and obtained again once when the agent answers 401.

export interface ClientCredentialsOptions {
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly scope: string;
    /** The Problem to throw when the token endpoint refuses; `diagnostic` is the endpoint's own words. */
    readonly refuse: (diagnostic: string) => Error;
    readonly fetchImpl?: typeof fetch;
}

export default class ClientCredentials {
    readonly #options: ClientCredentialsOptions;
    #token: string | null = null;
    #acquiring: Promise<string> | null = null;

    constructor(options: ClientCredentialsOptions) {
        this.#options = options;
    }

    /** Obtains the first token now, so a refusal is a preparation outcome rather than a mid-request surprise. */
    async prime(signal?: AbortSignal): Promise<void> {
        await this.#access(signal);
    }

    /** The SDK's authentication handler face ({@link createAuthenticatingFetchWithRetry}). */
    get handler(): {
        headers: () => Promise<Record<string, string>>;
        shouldRetryWithHeaders: (req: RequestInit, res: Response) => Promise<Record<string, string> | undefined>;
    } {
        return {
            headers: async () => ({ Authorization: `Bearer ${await this.#access()}` }),
            shouldRetryWithHeaders: async (_req, res) => {
                if (res.status !== 401) return undefined;
                this.#token = null;
                return { Authorization: `Bearer ${await this.#access()}` };
            },
        };
    }

    async #access(signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        if (this.#token !== null) return this.#token;
        this.#acquiring ??= this.#acquire(signal).finally(() => { this.#acquiring = null; });
        return this.#acquiring;
    }

    async #acquire(signal?: AbortSignal): Promise<string> {
        const { tokenUrl, clientId, clientSecret, scope, refuse, fetchImpl = fetch } = this.#options;
        const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
        if (scope.length > 0) body.set("scope", scope);
        let response: Response;
        try {
            response = await fetchImpl(tokenUrl, {
                signal,
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
                body: body.toString(),
            });
        } catch (cause) {
            signal?.throwIfAborted();
            throw refuse(cause instanceof Error ? cause.message : String(cause));
        }
        const answer = await response.json().catch(() => null) as { access_token?: unknown; error?: unknown; error_description?: unknown } | null;
        signal?.throwIfAborted();
        if (!response.ok || answer === null || typeof answer.access_token !== "string" || answer.access_token.length === 0) {
            const error = typeof answer?.error === "string" ? answer.error : String(response.status);
            const description = typeof answer?.error_description === "string" ? answer.error_description : "";
            throw refuse(description.length === 0 ? error : `${error}: ${description}`);
        }
        this.#token = answer.access_token;
        return this.#token;
    }
}
