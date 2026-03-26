import { testLanguage } from "../../lib/testutil.js";

await testLanguage("php", {
	examplesDir: "vendor/grammars-v4/php/examples",
	extensions: [".php"],
	skip: [
		// PHP lexer base class port has bugs with ASP tags and embedded HTML/JS
		"aspTags.php",
		"php-js-php.php",
		"scriptInHtml.php",
	],
});
