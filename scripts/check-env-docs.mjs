import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");

function documentedVariables(path) {
	return new Set(
		read(path)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
			.map((line) => line.split("=", 1)[0]),
	);
}

function assertDocumented(label, referenced, documented, allowedExtras = new Set()) {
	const missing = [...referenced].filter(
		(name) => !documented.has(name) && !allowedExtras.has(name),
	);
	const unexpected = [...documented].filter(
		(name) => !referenced.has(name) && !allowedExtras.has(name),
	);
	if (missing.length || unexpected.length) {
		if (missing.length) console.error(`${label}: missing ${missing.join(", ")}`);
		if (unexpected.length) console.error(`${label}: undocumented extras ${unexpected.join(", ")}`);
		process.exitCode = 1;
	}
}

const webSource = read("apps/web/src/env.ts");
const webSchemaVariables = new Set(
	[...webSource.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*z\./gm)].map((match) => match[1]),
);
const webReferencedVariables = new Set(
	[...webSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]),
);
const webVariables = new Set([...webSchemaVariables, ...webReferencedVariables]);
assertDocumented(
	"apps/web",
	webVariables,
	documentedVariables("apps/web/.env.example"),
	new Set(["NODE_ENV"]),
);

const analyzerSource = read("apps/analyzer/app/core/settings.py");
const analyzerVariables = new Set(
	[...analyzerSource.matchAll(/^\s{4}([a-z][a-z0-9_]*)\s*:/gm)].map((match) => match[1].toUpperCase()),
);
assertDocumented(
	"apps/analyzer",
	analyzerVariables,
	documentedVariables("apps/analyzer/.env.example"),
);

if (process.exitCode) process.exit(process.exitCode);
console.log("Environment schema variables are documented.");
