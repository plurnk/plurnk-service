import { testLanguage } from "../../lib/testutil.js";

await testLanguage("verilog", {
	examplesDir: "vendor/grammars-v4/verilog/verilog/examples",
	extensions: [".v"],
});
