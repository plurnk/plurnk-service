// Driving the assembled daemon over its AG-UI listener from a test: a packet-capturing Mock, the
// Run input shape, the posted event stream and the standard action result, shared by the MCP
// composition witnesses and the third-party live specimen.
import assert from "node:assert/strict";
import { chatMessageText, Mock } from "@plurnk/plurnk-providers";

export type Event = Readonly<Record<string, unknown>>;

export class PacketCapturingMock extends Mock {
    readonly requests: Array<ReadonlyArray<{ readonly role: string; readonly content: string }>> = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map((message) => ({ role: message.role, content: chatMessageText(message) })));
        return super.generate(...args);
    }
}

export const parseEvents = (body: string): Event[] => body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as Event);

export const post = async (port: number, input: Readonly<Record<string, unknown>>): Promise<Event[]> => {
    // {§agui-http-authorization} — under the live tier the operator's minted bearer is in the
    // environment and the listener requires it; the intg tier mints none and sends none.
    const token = process.env.PLURNK_AGUI_SECRET;
    const response = await fetch(`http://127.0.0.1:${port}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(input),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    return parseEvents(await response.text());
};

export const runInput = (
    workspace: string,
    runId: string,
    additions: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
    threadId: workspace,
    runId,
    state: {},
    messages: [],
    tools: [{ name: "request_approval", description: "Review proposals.", parameters: { type: "object" } }],
    context: [],
    forwardedProps: { plurnk: { workspace } },
    ...additions,
});

export const actionResult = (events: readonly Event[]): {
    readonly ok: boolean;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly problem?: Readonly<Record<string, unknown>>;
} => {
    const event = events.find((candidate) =>
        candidate.type === "CUSTOM" && candidate.name === "plurnk.action.result") as {
        readonly value?: {
            readonly ok: boolean;
            readonly result?: Readonly<Record<string, unknown>>;
            readonly problem?: Readonly<Record<string, unknown>>;
        };
    } | undefined;
    assert.ok(event?.value !== undefined, "the AG-UI action returned its standard result event");
    return event.value;
};

export const packet = (requests: PacketCapturingMock["requests"], index: number): string =>
    requests[index]?.map(({ content }) => content).join("\n\n") ?? "";
