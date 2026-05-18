import TextPlain from "../mimetypes/TextPlain.ts";
import type { MimetypeHandler } from "../mimetypes/_types.ts";

// text/plain is the bundled fallback — no external dep, every deployment
// needs it as the universal text mimetype. All other mimetype handlers ship
// as @plurnk/plurnk-mimetypes-* packages and are registered by Daemon's
// plugin discovery scan (see Daemon.#discoverAndLoadPlugins). The "bundle
// minimally" principle: plurnk-service ships enough to run standalone, not
// every plausible handler.
export default class MimetypeRegistry {
    #handlers = new Map<string, MimetypeHandler>();

    constructor() {
        this.register(new TextPlain());
    }

    register(handler: MimetypeHandler): void {
        if (this.#handlers.has(handler.mimetype)) {
            throw new Error(`mimetype '${handler.mimetype}' is already registered`);
        }
        this.#handlers.set(handler.mimetype, handler);
    }

    get(mimetype: string): MimetypeHandler {
        const handler = this.#handlers.get(mimetype);
        if (handler === undefined) {
            throw new Error(`no handler registered for mimetype '${mimetype}'`);
        }
        return handler;
    }

    has(mimetype: string): boolean {
        return this.#handlers.has(mimetype);
    }

    list(): string[] {
        return [...this.#handlers.keys()].toSorted();
    }
}
