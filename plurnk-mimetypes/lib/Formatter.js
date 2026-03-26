import path from "node:path";

export default class Formatter {
	static toJSON(results, rootDir) {
		return results.map(({ file, symbols }) => ({
			file: path.relative(rootDir, file),
			symbols,
		}));
	}
}
