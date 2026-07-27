// The one readable projection of a durable log result. READ, FIND, token
// metadata, and the persistent semantic/graph derivation index all consume this
// exact content. Storage JSON is an envelope; a string `content` is the body.

export interface LogProjection {
    readonly content: string;
    readonly mimetype: string;
}

export default class LogProjectionResolver {
    static resolve(rawRx: string): LogProjection {
        try {
            const rx = JSON.parse(rawRx) as { content?: unknown; mimetype?: unknown };
            if (typeof rx.content === "string") {
                return {
                    content: rx.content,
                    mimetype: typeof rx.mimetype === "string" ? rx.mimetype : "text/plain",
                };
            }
            return { content: JSON.stringify(rx), mimetype: "application/json" };
        } catch {
            return { content: rawRx, mimetype: "text/plain" };
        }
    }
}
