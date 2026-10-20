import type { EntryData, RepresentationPreparationRequest, SchemeCtx } from "@plurnk/plurnk-schemes";
import { Results } from "@plurnk/plurnk-schemes";

export const preparationRequest = (pathname: string): RepresentationPreparationRequest => ({
    target: {
        kind: "url",
        raw: `echo://${pathname}`,
        scheme: "echo",
        username: null,
        password: null,
        hostname: null,
        port: null,
        pathname,
        query: null,
        fragment: null,
    },
    metadata: null,
    authority: "",
    pathname,
});

// A scheme context whose entries are one in-memory map.
export const context = (): {
    ctx: SchemeCtx;
    entries: Map<string, EntryData>;
} => {
    const entries = new Map<string, EntryData>();
    const ctx = {
        signal: undefined,
        interactions: {
            request: async () => ({ status: "cancelled" as const }),
        },
        entries: {
            address: async (pathname: string) => `echo://owner${pathname}`,
            read: async (pathname: string) => entries.has(pathname)
                ? { status: 200, entry: entries.get(pathname)! }
                : Results.failure("scheme:echo", "entry-not-found", 404, "No entry exists at this path.", { entry: null }),
            write: async (pathname: string, entry: EntryData) => {
                entries.set(pathname, entry);
                return {
                    status: 200,
                    created: true,
                    entryId: entries.size,
                };
            },
            operations: {},
        },
    } as unknown as SchemeCtx;
    return { ctx, entries };
};
