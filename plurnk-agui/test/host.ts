// {§http-host} — hosts the module for tests against a mock port the way the daemon's listener
// does: the module mounts its routes at start, and the socket opens only after start returns, as
// the daemon admits its listener only after every module has started ({§agui-listener-admission}).
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Module, { type AguiPort, type AguiSetupSeam, type ModuleOptions } from "../src/Module.ts";
import type { HttpRouteHandler } from "@plurnk/plurnk-contracts/port";

export interface Hosted {
    readonly module: Module;
    address(): { readonly host: string; readonly port: number };
    stop(): void;
    close(): Promise<void>;
}

export const host = async (seam: AguiPort, options: ModuleOptions = {}, observeResponse?: (response: ServerResponse) => void): Promise<Hosted> => {
    const routes = new Map<string, HttpRouteHandler>();
    // The mock's members stay live through the prototype: a test may replace one after start.
    const port: AguiPort = Object.assign(Object.create(seam) as AguiPort, {
        registerHttpRoute: (prefix: string, handler: HttpRouteHandler): void => { routes.set(prefix, handler); },
    });
    // {§credential-authority} — a hosted module rides the shipped panel, whose posture is on; a test that
    // brings no floor of its own runs anonymously, and one that authenticates says so in its floor or
    // its options.
    const module = Module.create(options.env === undefined && options.auth === undefined ? { ...options, auth: false } : options);
    // {§module-phases} — setup precedes start when the seam can take it: a scheme to register, a face to publish.
    if ("registerScheme" in port) await module.setup(port as unknown as AguiSetupSeam);
    await module.start(port);
    const server = createServer((req, res) => {
        observeResponse?.(res);
        const pathname = new URL(req.url ?? "/", "http://host").pathname;
        const handler = [...routes.entries()].find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.[1];
        if (handler === undefined) throw new Error(`the module mounted no route for '${pathname}'`);
        void handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    const { port: bound } = server.address() as AddressInfo;
    return {
        module,
        address: () => ({ host: "127.0.0.1", port: bound }),
        stop: () => module.stop(),
        close: async () => {
            await module.close();
            // An unread stream would hold the socket open past the module's end; the daemon's listener ends them too.
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((cause) => (cause === undefined ? resolve() : reject(cause))));
        },
    };
};
