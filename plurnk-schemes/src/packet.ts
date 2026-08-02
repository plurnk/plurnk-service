// {§scheme-packet-transform} — public authoring surface for trusted packet
// transforms. #73 owns the remaining draft/measured-section type distinction.

export interface PacketSection {
    readonly name: string;
    readonly slot: "system" | "user";
    readonly header: string | null;
    readonly content: string;
    readonly tokens: number;
}

export interface PacketSectionTransformer {
    transformSections(sections: PacketSection[]): PacketSection[] | Promise<PacketSection[]>;
}
