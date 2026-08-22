import {
    ClientFactory,
    RestTransportFactory,
    type Client,
} from "@a2a-js/sdk/client";

/**
 * Discover an A2A v1 Agent Card and connect through its HTTP+JSON interface.
 * The standard well-known card path is used unless `agentCardPath` is given.
 */
export const connectHttpJsonAgent = (
    baseUrl: string,
    agentCardPath?: string,
): Promise<Client> => {
    const factory = new ClientFactory({
        transports: [new RestTransportFactory()],
        preferredTransports: ["HTTP+JSON"],
    });
    return factory.createFromUrl(baseUrl, agentCardPath);
};
