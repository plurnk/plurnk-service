import {
    ClientFactory,
    DefaultAgentCardResolver,
    RestTransportFactory,
    type Client,
} from "@a2a-js/sdk/client";
import type { AgentCard } from "@a2a-js/sdk";

export interface HttpJsonConnectionOptions {
    /** Exact request headers applied to card discovery and every protocol request. */
    readonly headers?: Readonly<Record<string, string>>;
    readonly fetchImpl?: typeof fetch;
}

const fetchWith = ({ headers, fetchImpl = fetch }: HttpJsonConnectionOptions): typeof fetch => {
    if (headers === undefined || Object.keys(headers).length === 0) return fetchImpl;
    return (input, init) => {
        const merged = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        for (const [name, value] of Object.entries(headers)) merged.set(name, value);
        return fetchImpl(input, { ...init, headers: merged });
    };
};

/**
 * Discover one standard A2A Agent Card without creating a client: inert
 * discovery. The standard well-known card path is used unless `agentCardPath`
 * is given.
 */
export const discoverAgentCard = (
    baseUrl: string,
    agentCardPath?: string,
    options: HttpJsonConnectionOptions = {},
): Promise<AgentCard> => new DefaultAgentCardResolver({ fetchImpl: fetchWith(options) }).resolve(baseUrl, agentCardPath);

/**
 * Discover an A2A v1 Agent Card and connect through its HTTP+JSON interface.
 * The standard well-known card path is used unless `agentCardPath` is given.
 */
export const connectHttpJsonAgent = (
    baseUrl: string,
    agentCardPath?: string,
    options: HttpJsonConnectionOptions = {},
): Promise<Client> => {
    const fetchImpl = fetchWith(options);
    const factory = new ClientFactory({
        transports: [new RestTransportFactory({ fetchImpl })],
        preferredTransports: ["HTTP+JSON"],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    });
    return factory.createFromUrl(baseUrl, agentCardPath);
};

/** Connect through an already-discovered card (no second discovery request). */
export const connectHttpJsonAgentFromCard = (
    card: AgentCard,
    options: HttpJsonConnectionOptions = {},
): Promise<Client> => {
    const fetchImpl = fetchWith(options);
    const factory = new ClientFactory({
        transports: [new RestTransportFactory({ fetchImpl })],
        preferredTransports: ["HTTP+JSON"],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
    });
    return factory.createFromAgentCard(card);
};
