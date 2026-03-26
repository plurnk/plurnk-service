import Cobol85Visitor from "./generated/Cobol85Visitor.js";

class SymbolExtractor extends Cobol85Visitor {
	#symbols = [];

	get symbols() {
		return this.#symbols;
	}

	#add(kind, name, ctx) {
		this.#symbols.push({
			name,
			kind,
			line: ctx.start.line,
			endLine: ctx.stop?.line ?? ctx.start.line,
		});
	}

	visitProgramIdParagraph(ctx) {
		const name = ctx.programName?.();
		if (name) this.#add("module", name.getText(), ctx);
		return null;
	}

	visitProcedureSection(ctx) {
		const header = ctx.procedureSectionHeader?.();
		const sectionName = header?.sectionName?.();
		if (sectionName) this.#add("function", sectionName.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitParagraph(ctx) {
		const name = ctx.paragraphName?.();
		if (name) this.#add("method", name.getText(), ctx);
		return null;
	}

	visitDataDescriptionEntryFormat1(ctx) {
		const levelText = ctx.INTEGERLITERAL?.()?.getText();
		const isLevel77 = ctx.LEVEL_NUMBER_77?.();
		if (levelText !== "01" && !isLevel77) return null;
		const name = ctx.dataName?.();
		if (name) this.#add("field", name.getText(), ctx);
		return null;
	}
}

export default class Cobol85Map {
	static status = "done";
	static entryRule = "startRule";
	static extensions = [".cbl", ".cob", ".cobol"];

	static extract(tree) {
		const visitor = new SymbolExtractor();
		visitor.visit(tree);
		return visitor.symbols;
	}
}
