import antlr4 from "antlr4";
import TypeScriptParser from "./TypeScriptParser.js";

export default class TypeScriptParserBase extends antlr4.Parser {
	constructor(input) {
		super(input);
	}

	p(str) {
		return this.prev(str);
	}

	prev(str) {
		return this._input.LT(-1).text === str;
	}

	n(str) {
		return this.next(str);
	}

	next(str) {
		return this._input.LT(1).text === str;
	}

	notLineTerminator() {
		return !this.here(TypeScriptParser.LineTerminator);
	}

	notOpenBraceAndNotFunctionAndNotInterface() {
		const nextTokenType = this._input.LT(1).type;
		return nextTokenType != TypeScriptParser.OpenBrace && nextTokenType != TypeScriptParser.Function_ && nextTokenType != TypeScriptParser.Interface;
	}

	closeBrace() {
		return this._input.LT(1).type == TypeScriptParser.CloseBrace;
	}

	here(type) {
		const possibleIndexEosToken = this.getCurrentToken().tokenIndex - 1;
		const ahead = this._input.get(possibleIndexEosToken);
		return (ahead.channel == antlr4.Token.HIDDEN_CHANNEL) && (ahead.type == type);
	}

	lineTerminatorAhead() {
		let possibleIndexEosToken = this.getCurrentToken().tokenIndex - 1;
		let ahead = this._input.get(possibleIndexEosToken);

		if (ahead.channel != antlr4.Token.HIDDEN_CHANNEL) return false;
		if (ahead.type == TypeScriptParser.LineTerminator) return true;
		if (ahead.type == TypeScriptParser.WhiteSpaces) {
			possibleIndexEosToken = this.getCurrentToken().tokenIndex - 2;
			ahead = this._input.get(possibleIndexEosToken);
		}

		const text = ahead.text;
		const type = ahead.type;
		return (type == TypeScriptParser.MultiLineComment && (text.includes("\r") || text.includes("\n"))) || (type == TypeScriptParser.LineTerminator);
	}
}
