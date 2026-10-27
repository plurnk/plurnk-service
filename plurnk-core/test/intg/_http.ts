import HttpListener from "../../src/server/HttpListener.ts";
import type { HttpHost } from "@plurnk/plurnk-contracts/port";

// {§http-host} — the one listener a test binds before its daemon exists, as the service
// does ({§startup-admission}); the test closes it after the daemon stops.
export const bindListener = (): Promise<HttpListener> => HttpListener.bind({ host: "127.0.0.1", port: 0 });

export const serviceUrl = (host: HttpHost): string => {
    const address = host.httpAddress();
    return `http://${address.host}:${address.port}`;
};
