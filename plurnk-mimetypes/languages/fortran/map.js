import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import Fortran90ParserVisitor from "./generated/Fortran90ParserVisitor.js";

class Extractor extends withExtractor(Fortran90ParserVisitor) {
	visitBody(ctx) {
		return this._gateBody(ctx);
	}

	visitMainProgram(ctx) {
		const stmt = ctx.programStmt?.();
		const name =
			stmt?.NAME?.()?.getText() ?? stmt?.getText()?.replace(/^PROGRAM\s*/i, "");
		if (name) this._add("function", name, ctx);
		return this.visitChildren(ctx);
	}

	visitFunctionSubprogram(ctx) {
		if (this._inBody) return null;
		const name = ctx.functionName?.()?.getText();
		if (name) this._add("function", name, ctx);
		return this.visitChildren(ctx);
	}

	visitSubroutineSubprogram(ctx) {
		if (this._inBody) return null;
		const name = ctx.subroutineName?.()?.getText();
		if (name) this._add("function", name, ctx);
		return this.visitChildren(ctx);
	}

	visitModule(ctx) {
		if (this._inBody) return null;
		const stmt = ctx.moduleStmt?.();
		const name = stmt?.moduleName?.()?.getText();
		if (name) this._add("module", name, ctx);
		return this.visitChildren(ctx);
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "program",
	extensions: [".f90", ".f95", ".f03", ".f08"],
});
