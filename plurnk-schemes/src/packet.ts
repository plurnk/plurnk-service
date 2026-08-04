// {§scheme-packet-transform} — public authoring surface for trusted packet
// transforms. Measurement remains core-owned.

export interface PacketSectionDraft {
    readonly name: string;
    readonly slot: "system" | "user";
    readonly header: string | null;
    readonly content: string;
}

export interface PacketSectionTransformer {
    transformSections(sections: PacketSectionDraft[]): PacketSectionDraft[] | Promise<PacketSectionDraft[]>;
}
