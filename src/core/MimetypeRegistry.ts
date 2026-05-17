import TextPlain from "../mimetypes/TextPlain.ts";
import TextMarkdown from "../mimetypes/TextMarkdown.ts";
import type { MimetypeHandler } from "../mimetypes/_types.ts";

export default class MimetypeRegistry {
    #handlers = new Map<string, MimetypeHandler>();

    constructor() {
        this.register(new TextPlain());
        this.register(new TextMarkdown());
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
