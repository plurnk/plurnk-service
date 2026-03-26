import { testLanguage } from "../../lib/testutil.js";

await testLanguage("cpp", {
	examplesDir: "vendor/grammars-v4/cpp/examples",
	extensions: [".cpp", ".cxx", ".cc", ".hpp"],
});
