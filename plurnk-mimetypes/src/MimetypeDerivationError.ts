const bounded = (value: string): string => value.length <= 512
    ? value
    : `${value.slice(0, 255)}…${value.slice(-256)}`;

// {§mimetype-derivation-evidence}: context belongs to the invocation, never
// to the original error, which may be frozen or shared by concurrent calls.
export default class MimetypeDerivationError extends Error {
    readonly path: string | null;
    readonly mimetype: string;

    constructor(args: { path?: string; mimetype: string; cause: unknown }) {
        const path = args.path === undefined ? null : bounded(args.path);
        const mimetype = bounded(args.mimetype);
        super(`Mimetype derivation failed for ${path === null ? "content" : JSON.stringify(path)} (${JSON.stringify(mimetype)}).`, { cause: args.cause });
        this.name = "MimetypeDerivationError";
        this.path = path;
        this.mimetype = mimetype;
    }
}
