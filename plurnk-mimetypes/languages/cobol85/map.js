import { createMap, withExtractor } from "../../lib/BaseExtractor.js";
import Cobol85Visitor from "./generated/Cobol85Visitor.js";

class Extractor extends withExtractor(Cobol85Visitor) {
	visitProgramIdParagraph(ctx) {
		const name = ctx.programName?.();
		if (name) this._add("module", name.getText(), ctx);
		return null;
	}

	visitProcedureSection(ctx) {
		const header = ctx.procedureSectionHeader?.();
		const sectionName = header?.sectionName?.();
		if (sectionName) this._add("function", sectionName.getText(), ctx);
		return this.visitChildren(ctx);
	}

	visitParagraph(ctx) {
		const name = ctx.paragraphName?.();
		if (name) this._add("method", name.getText(), ctx);
		return null;
	}

	visitDataDescriptionEntryFormat1(ctx) {
		const levelText = ctx.INTEGERLITERAL?.()?.getText();
		const isLevel77 = ctx.LEVEL_NUMBER_77?.();
		if (levelText !== "01" && !isLevel77) return null;
		const name = ctx.dataName?.();
		if (name) this._add("field", name.getText(), ctx);
		return null;
	}
}

export default createMap({
	ExtractorClass: Extractor,
	entryRule: "startRule",
	extensions: [".cbl", ".cob", ".cobol"],
});
