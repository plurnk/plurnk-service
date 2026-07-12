// The packet-section transform hook (plurnk-service 566715d, schemes#24).
//
// A scheme MAY reshape the packet's section list — add / remove / reorder —
// before the engine measures it. The engine builds its default section list,
// then pipes it through every registered scheme that implements
// `transformSections`, in registration order. It's the trusted, in-process seam
// for plugin packet control (the client wire never touches the packet), and the
// fork-avoidance valve: a plugin that can reshape the packet to its needs has no
// reason to fork the engine.
//
// OPTIONAL and STANDALONE — compose it with SchemeHandler:
//   export default class X implements SchemeHandler, PacketSectionTransformer {…}
// The engine calls it duck-typed (`typeof handler.transformSections === "function"`),
// so declaring it here just gives an external author a typed surface + discovery.
//
// `PacketSection` is the engine's packet-row shape — service-owned at runtime
// (grammar 0.67 dropped `Packet.json`), but the CONTRACT declares the shape so a
// sibling can implement the hook without importing plurnk-service; service
// conforms its packet builder to it. Same direction as `SchemeManifest` /
// `SchemeCtx`: contract declares, service implements.

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
