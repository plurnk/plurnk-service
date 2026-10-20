import type { ClientEntryChannel } from "./types.generated.ts";

/** {§methods-worker-streams} A stream the worker holds open: what it is, how long it lives, the operation that opened it, and
 *  the state of each of its channels. Identity and coordinates are named as `stream/event` names them. */
export interface ApplicationStream {
    readonly entryId: number;
    /** The initiating Worker ({§subscriptions-causal-resource}). */
    readonly workerId: number;
    /** The canonical resource URI ({§execution-output-identity}). */
    readonly target: string;
    /** {§exec-lifetime}: ended with its loop, reaped before the worker's next turn, or outliving its loop. */
    readonly lifetime: "loop" | "turn" | "detached";
    /** The causal log item, when the stream began in a turn. */
    readonly loop_seq?: number;
    readonly turn_seq?: number;
    readonly sequence?: number;
    /** Every channel of the stream's entry, written or not, by name. */
    readonly channels: readonly ApplicationStreamChannel[];
}

export interface ApplicationStreamChannel {
    readonly channel: string;
    readonly state: ClientEntryChannel["state"];
    readonly mimetype: string;
}
