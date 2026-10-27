// Binary mimetype classifier used at operation boundaries (SPEC {§op-invariants}).
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";

export default class MimetypeBinary {
    static async isBinaryMimetype(mimetype: string, mimetypes: Mimetypes | undefined): Promise<boolean> {
        if (mimetypes === undefined) {
            throw new Error("MimetypeBinary.isBinaryMimetype: configured mimetype registry is required");
        }
        return (await mimetypes.classify(mimetype)).binary;
    }
}
