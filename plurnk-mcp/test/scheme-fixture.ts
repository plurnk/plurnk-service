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
    subscriptions: Map<string, {
        aborted: boolean;
        close(result: { status: number }): Promise<void>;
        closedWith?: number;
    }>;
} => {
    const entries = new Map<string, EntryData>();
    const subscriptions = new Map<string, {
        aborted: boolean;
        close(result: { status: number }): Promise<void>;
        closedWith?: number;
    }>();
    const ctx = {
        workspaceId: 1,
        sessionId: 1,
        loopId: 0,
        signal: undefined,
        interactions: {
            request: async () => ({ status: "cancelled" as const }),
        },
        subscriptions: {
            open: async (pathname: string) => {
                const sub: {
                    aborted: boolean;
                    close(result: { status: number }): Promise<void>;
                    closedWith?: number;
                } = {
                    aborted: false,
                    close: async (result) => {
                        sub.closedWith = result.status;
                    },
                };
                subscriptions.set(pathname, sub);
                return sub;
            },
        },
        messages: {
            prepare: async () => ({ status: 200 as const }),
            reply: async () => ({ status: 200 as const }),
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
            operations: {
                find: async () => ({
                    status: 200 as const,
                    content: "",
                    mimetype: "text/markdown",
                    results: [],
                    itemsWeightTotal: 0,
                    returnedItemsWeightTotal: 0,
                    matchingPathCount: 0,
                    matchLocationCount: 0,
                }),
            },
        },
    } as unknown as SchemeCtx;
    return { ctx, entries, subscriptions };
};
