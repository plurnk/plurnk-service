import semver from "semver";

const INSTALL_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

// {§release-candidate-graph}: package identities and dependency contracts own the graph.
export const candidateGraph = (manifests) => {
    const graph = new Map();
    for (const manifest of manifests) {
        const { name, version } = manifest;
        if (typeof name !== "string" || name.length === 0) throw new Error("candidate package has no name");
        if (semver.valid(version) !== version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`${name}: invalid package version ${JSON.stringify(version)}; expected stable major.minor.patch`);
        if (graph.has(name)) throw new Error(`duplicate candidate package ${name}`);
        graph.set(name, manifest);
    }
    for (const { name, version, ...manifest } of graph.values()) {
        for (const field of [...INSTALL_FIELDS, "devDependencies"]) {
            for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
                const selected = graph.get(dependency);
                if (selected !== undefined && (typeof range !== "string" || !semver.satisfies(selected.version, range))) {
                    throw new Error(`${name}@${version}: ${field}.${dependency}@${range} excludes candidate ${selected.version}`);
                }
            }
        }
    }
    return graph;
};

export const publicationOrder = (graph) => {
    const complete = new Set();
    const active = [];
    const ordered = [];
    const visit = (name) => {
        if (complete.has(name)) return;
        if (active.includes(name)) throw new Error(`publication cycle: ${[...active.slice(active.indexOf(name)), name].join(" -> ")}`);
        active.push(name);
        const manifest = graph.get(name);
        for (const field of INSTALL_FIELDS) {
            for (const dependency of Object.keys(manifest[field] ?? {}).sort()) {
                if (graph.has(dependency)) visit(dependency);
            }
        }
        active.pop();
        complete.add(name);
        ordered.push(manifest);
    };
    for (const name of [...graph.keys()].sort()) visit(name);
    return ordered;
};

export const publicationBatches = (graph) => {
    const depths = new Map();
    const batches = [];
    for (const manifest of publicationOrder(graph)) {
        const dependencies = INSTALL_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})).filter((name) => graph.has(name));
        const depth = dependencies.reduce((maximum, name) => Math.max(maximum, depths.get(name) + 1), 0);
        depths.set(manifest.name, depth);
        (batches[depth] ??= []).push(manifest);
    }
    return batches;
};
