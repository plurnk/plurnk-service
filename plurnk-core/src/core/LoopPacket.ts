import type { ApplicationLoopPacket } from "@plurnk/plurnk-contracts";

export type LoopPacketNotify = (
    workspaceId: number,
    packet: ApplicationLoopPacket,
) => void;
