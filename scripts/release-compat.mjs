const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const CARET = /^\^(\d+)\.(\d+)\.(\d+)$/;

export const exactVersion = (value) => VERSION.exec(value ?? "");
export const caretRange = (value) => CARET.exec(value ?? "");

export const supportsVersion = (range, candidate) => {
    const floor = caretRange(range);
    const version = exactVersion(candidate);
    if (floor === null || version === null) return false;
    const [, floorMajor, floorMinor, floorPatch] = floor.map(Number);
    const [, major, minor, patch] = version.map(Number);
    if (major !== floorMajor) return false;
    if (floorMajor > 0) {
        return minor > floorMinor || (minor === floorMinor && patch >= floorPatch);
    }
    if (floorMinor > 0) return minor === floorMinor && patch >= floorPatch;
    return minor === 0 && patch === floorPatch;
};

export const compatibleRange = (version) => {
    if (exactVersion(version) === null) throw new Error(`invalid exact version ${JSON.stringify(version)}`);
    return `^${version}`;
};
