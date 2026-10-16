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
    // {§credential-authority} — both tiers boot their daemon with PLURNK_AUTH=0, so the listener admits anonymously.
    const response = await fetch(`http://127.0.0.1:${port}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
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

// {§agui-plurnk-metadata} An action Run finishes with the action's whole outcome as its result.
export const actionResult = (events: readonly Event[]): {
    readonly ok: boolean;
    readonly result?: Readonly<Record<string, unknown>>;
    readonly problem?: Readonly<Record<string, unknown>>;
} => {
    const outcome = events.find((candidate) => candidate.type === "RUN_FINISHED")?.result as {
        readonly ok: boolean;
        readonly result?: Readonly<Record<string, unknown>>;
        readonly problem?: Readonly<Record<string, unknown>>;
    } | undefined;
    assert.ok(outcome !== undefined, "the AG-UI action Run finished with its outcome as its result");
    return outcome;
};

export const packet = (requests: PacketCapturingMock["requests"], index: number): string =>
    requests[index]?.map(({ content }) => content).join("\n\n") ?? "";
