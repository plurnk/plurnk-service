import antlr4 from "antlr4";
import RustParser from "./RustParser.js";

export default class RustParserBase extends antlr4.Parser {
	constructor(input) {
		super(input);
	}

	NextGT() {
		return this._input.LA(1) === RustParser.GT;
	}

	NextLT() {
		return this._input.LA(1) === RustParser.LT;
	}
}
