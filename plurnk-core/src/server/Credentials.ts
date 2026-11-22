import type { CredentialAuthority, CredentialFace, VerifiedBearerClaims } from "@plurnk/plurnk-contracts";

// {§credential-authority} — the daemon's one authority over bearer credentials presented to its
// listener. Unconfigured by default (`face() === null`), admitting loopback and proxy-fronted
// traffic directly; when an authentication module publishes a `CredentialFace` at `setup()`, all
// exterior adapters verify bearer tokens through it.
export default class Credentials implements CredentialAuthority {
    #face: CredentialFace | null = null;

    publish(face: CredentialFace): void {
        if (this.#face !== null) {
            throw new Error("A credential face is already published on this daemon.");
        }
        this.#face = face;
    }

    face(): CredentialFace | null {
        return this.#face;
    }

    async verify(token: string): Promise<VerifiedBearerClaims | null> {
        if (this.#face === null || token.trim().length === 0) return null;
        return await this.#face.verify(token);
    }
}
