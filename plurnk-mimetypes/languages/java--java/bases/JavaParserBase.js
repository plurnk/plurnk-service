import antlr4 from "antlr4";
import JavaParser from "./JavaParser.js";

export default class JavaParserBase extends antlr4.Parser {
	constructor(input) {
		super(input);
	}

	DoLastRecordComponent() {
		const ctx = this.getContext();
		if (!(ctx instanceof JavaParser.RecordComponentListContext)) return true;
		const rcs = ctx.recordComponent();
		if (!rcs || rcs.length === 0) return true;
		for (let c = 0; c < rcs.length; c++) {
			if (rcs[c].ELLIPSIS() != null && c + 1 < rcs.length) return false;
		}
		return true;
	}

	IsNotIdentifierAssign() {
		const la = this._input.LA(1);
		switch (la) {
			case JavaParser.IDENTIFIER:
			case JavaParser.MODULE:
			case JavaParser.OPEN:
			case JavaParser.REQUIRES:
			case JavaParser.EXPORTS:
			case JavaParser.OPENS:
			case JavaParser.TO:
			case JavaParser.USES:
			case JavaParser.PROVIDES:
			case JavaParser.WHEN:
			case JavaParser.WITH:
			case JavaParser.TRANSITIVE:
			case JavaParser.YIELD:
			case JavaParser.SEALED:
			case JavaParser.PERMITS:
			case JavaParser.RECORD:
			case JavaParser.VAR:
				break;
			default:
				return true;
		}
		return this._input.LA(2) !== JavaParser.ASSIGN;
	}
}
