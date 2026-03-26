import antlr4 from "antlr4";

export default class PhpLexerBase extends antlr4.Lexer {
	constructor(input) {
		super(input);
		this.AspTags = true;
		this._scriptTag = false;
		this._styleTag = false;
		this._heredocIdentifier = undefined;
		this._prevTokenType = 0;
		this._htmlNameText = undefined;
		this._phpScript = false;
		this._insideString = false;
	}

	nextToken() {
		let token = super.nextToken();

		if (token.type === this.PHPEnd || token.type === this.PHPEndSingleLineComment) {
			if (this._mode === this.SingleLineCommentMode) {
				this.popMode();
			}
			this.popMode();

			if (token.text === "</script>") {
				this._phpScript = false;
				token.type = this.HtmlScriptClose;
			} else {
				if (this._prevTokenType === this.SemiColon || this._prevTokenType === this.Colon || this._prevTokenType === this.OpenCurlyBracket || this._prevTokenType === this.CloseCurlyBracket) {
					token = super.nextToken();
				} else {
					token = new antlr4.CommonToken();
					token.type = this.SemiColon;
					token.text = ";";
				}
			}
		} else if (token.type === this.HtmlName) {
			this._htmlNameText = token.text;
		} else if (token.type === this.HtmlDoubleQuoteString) {
			if (token.text === "php" && this._htmlNameText === "language") {
				this._phpScript = true;
			}
		} else if (this._mode === this.HereDoc) {
			if (token.type === this.StartHereDoc || token.type === this.StartNowDoc) {
				this._heredocIdentifier = token.text.slice(3).trim().replace(/\'$/, "");
			}
			if (token.type === this.HereDocText) {
				if (this.CheckHeredocEnd(token.text)) {
					this.popMode();
					const heredocIdentifier = this.GetHeredocEnd(token.text);
					if (token.text.trim().endsWith(";")) {
						token = new antlr4.CommonToken();
						token.type = this.SemiColon;
						token.text = `${heredocIdentifier};\n`;
					} else {
						token = super.nextToken();
						token.text = `${heredocIdentifier}\n;`;
					}
				}
			}
		} else if (this._mode === this.PHP) {
			if (this._channel === this.HIDDEN) {
				this._prevTokenType = token.type;
			}
		}

		return token;
	}

	GetHeredocEnd(text) {
		return text.trim().replace(/;$/, "");
	}

	CheckHeredocEnd(text) {
		return this.GetHeredocEnd(text) === this._heredocIdentifier;
	}

	IsNewLineOrStart(pos) {
		return this._input.LA(pos) <= 0 || this._input.LA(pos) === 13 || this._input.LA(pos) === 10;
	}

	PushModeOnHtmlClose() {
		this.popMode();
		if (this._scriptTag) {
			this.pushMode(this._phpScript ? this.PHP : this.SCRIPT);
			this._scriptTag = false;
		} else if (this._styleTag) {
			this.pushMode(this.STYLE);
			this._styleTag = false;
		}
	}

	HasAspTags() {
		return this.AspTags;
	}

	HasPhpScriptTag() {
		return this._phpScript;
	}

	PopModeOnCurlyBracketClose() {
		if (this._insideString) {
			this._insideString = false;
			this.popMode();
		}
	}

	ShouldPushHereDocMode(pos) {
		return this._input.LA(pos) === 13 || this._input.LA(pos) === 10;
	}

	IsCurlyDollar(pos) {
		return this._input.LA(pos) === 36;
	}

	SetInsideString() {
		this._insideString = true;
	}
}
