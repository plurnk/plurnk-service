import type { OperationResult } from "@plurnk/plurnk-contracts";

// {§scheme-awaited-events} The producer's finite identity is opaque to Core.
export interface AwaitedEvent {
    readonly event: string;
    readonly source: string;
    readonly dueAt?: string;
}

export interface AwaitedEventRecord extends AwaitedEvent {
    readonly workspaceId: number;
    readonly path: string;
    readonly result: OperationResult | null;
}

export interface AwaitedEventCaps {
    join(event: AwaitedEvent): Promise<OperationResult>;
    read(pathname: string): Promise<AwaitedEventRecord | null>;
    cancel(pathname: string): Promise<OperationResult>;
}

// Bound once to the owning scheme at module setup; retainable across calls.
export interface AwaitedEventProducer {
    pending(): Promise<readonly AwaitedEventRecord[]>;
    settle(workspaceId: number, event: string, result: OperationResult): Promise<void>;
}
