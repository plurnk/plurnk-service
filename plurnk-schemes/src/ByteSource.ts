// {§scheme-source-bytes} The source of a resource's original bytes. Coordinates
// are one-based and inclusive, like the public byte projection.
export interface ByteSource {
    size(): Promise<number | null>;
    read(start: number, end: number): Promise<Uint8Array>;
    nativePath?(): Promise<string | null>;
}
