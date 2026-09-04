const DEPENDENCY_FIELDS = Object.freeze([
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
]);

const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]));
};

export const managedDependencyContract = (manifest) => Object.fromEntries(
    DEPENDENCY_FIELDS.map((field) => [field, canonical(manifest[field] ?? {})]),
);

export const managedDependencyContractMatches = (checkout, published) =>
    JSON.stringify(managedDependencyContract(checkout))
    === JSON.stringify(managedDependencyContract(published));
