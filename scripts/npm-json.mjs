// {§release-candidate-graph}: npm 12 changed pack/view envelopes, not artifact identity.
export const packRecords = (source) => {
    const value = JSON.parse(source);
    const records = Array.isArray(value) ? value : value !== null && typeof value === "object" ? Object.values(value) : [];
    if (records.length === 0 || records.some((record) => typeof record?.filename !== "string" || record.filename.length === 0)) {
        throw new Error("npm pack returned no valid artifacts");
    }
    return records;
};

export const viewManifest = (source) => {
    const value = JSON.parse(source);
    const manifest = Array.isArray(value) && value.length === 1 ? value[0] : value;
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("npm view returned no unique package manifest");
    }
    return manifest;
};
