// {§http-host} — hosts the module for tests against a mock port the way the daemon's listener
// does: the module mounts its routes at start, and the socket opens only after start returns, as
// the daemon admits its listener only after every module has started ({§agui-listener-admission}).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { HttpRouteHandler } from "@plurnk/plurnk-contracts";
import Module, { type AguiPort, type ModuleOptions } from "../src/Module.ts";

export interface Hosted {
    readonly module: Module;
    address(): { readonly host: string; readonly port: number };
    stop(): void;
    close(): Promise<void>;
}

export const host = async (seam: AguiPort, options: ModuleOptions = {}): Promise<Hosted> => {
    const routes = new Map<string, HttpRouteHandler>();
    // The mock's members stay live through the prototype: a test may replace one after start.
    const port: AguiPort = Object.assign(Object.create(seam) as AguiPort, {
        registerHttpRoute: (prefix: string, handler: HttpRouteHandler): void => { routes.set(prefix, handler); },
    });
    const module = Module.create(options);
    await module.start(port);
    const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://host").pathname;
        const handler = routes.get(pathname === "/agui" || pathname.startsWith("/agui/") ? "/agui" : "/");
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
            module.close();
            await new Promise<void>((resolve, reject) => server.close((cause) => (cause === undefined ? resolve() : reject(cause))));
        },
    };
};
