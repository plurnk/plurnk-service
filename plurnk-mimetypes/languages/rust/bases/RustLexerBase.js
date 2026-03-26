import antlr4 from "antlr4";
import RustLexer from "./RustLexer.js";

export default class RustLexerBase extends antlr4.Lexer {
	constructor(input) {
		super(input);
		this.lt1 = null;
		this.lt2 = null;
	}

	nextToken() {
		const next = super.nextToken();
		if (next.channel === antlr4.Token.DEFAULT_CHANNEL) {
			this.lt2 = this.lt1;
			this.lt1 = next;
		}
		return next;
	}

	SOF() {
		return this._input.LA(-1) <= 0;
	}

	FloatDotPossible() {
		const next = this._input.LA(1);
		if (next === 46 || next === 95) return false; // '.' or '_'
		if (next === 102) { // 'f'
			if (this._input.LA(2) === 51 && this._input.LA(3) === 50) return true; // f32
			if (this._input.LA(2) === 54 && this._input.LA(3) === 52) return true; // f64
			return false;
		}
		if ((next >= 97 && next <= 122) || (next >= 65 && next <= 90)) return false;
		return true;
	}

	FloatLiteralPossible() {
		if (this.lt1 === null || this.lt2 === null) return true;
		if (this.lt1.type !== RustLexer.DOT) return true;
		switch (this.lt2.type) {
			case RustLexer.CHAR_LITERAL:
			case RustLexer.STRING_LITERAL:
			case RustLexer.RAW_STRING_LITERAL:
			case RustLexer.BYTE_LITERAL:
			case RustLexer.BYTE_STRING_LITERAL:
			case RustLexer.RAW_BYTE_STRING_LITERAL:
			case RustLexer.INTEGER_LITERAL:
			case RustLexer.DEC_LITERAL:
			case RustLexer.HEX_LITERAL:
			case RustLexer.OCT_LITERAL:
			case RustLexer.BIN_LITERAL:
			case RustLexer.KW_SUPER:
			case RustLexer.KW_SELFVALUE:
			case RustLexer.KW_SELFTYPE:
			case RustLexer.KW_CRATE:
			case RustLexer.KW_DOLLARCRATE:
			case RustLexer.GT:
			case RustLexer.RCURLYBRACE:
			case RustLexer.RSQUAREBRACKET:
			case RustLexer.RPAREN:
			case RustLexer.KW_AWAIT:
			case RustLexer.NON_KEYWORD_IDENTIFIER:
			case RustLexer.RAW_IDENTIFIER:
			case RustLexer.KW_MACRORULES:
				return false;
			default:
				return true;
		}
	}
}
