import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = new URL("../..", import.meta.url).pathname;
const srcRoot = join(webRoot, "src");
const serverRoot = join(srcRoot, "server");

function walk(directory: string): string[] {
	const entries: string[] = [];
	for (const name of readdirSync(directory)) {
		const absolute = join(directory, name);
		if (statSync(absolute).isDirectory()) {
			entries.push(...walk(absolute));
			continue;
		}
		if (/\.(ts|tsx)$/.test(name)) entries.push(absolute);
	}
	return entries;
}

const allSourceFiles = walk(srcRoot);
const isTest = (file: string) => /\.test\.tsx?$/.test(file);
const rel = (file: string) => relative(srcRoot, file);

const serverModules = walk(serverRoot).filter((file) => !isTest(file));
const clientModules = allSourceFiles
	.filter((file) => !isTest(file))
	.filter((file) =>
		/^\s*(?:\/\/[^\n]*\n\s*)*["']use client["']/.test(
			readFileSync(file, "utf8"),
		),
	);

// Import specifiers that pull in server-only modules or validated secrets.
const serverSpecifier =
	/from\s+["'](@\/server\/[^"']+|@\/env|@mailsentinel\/db|server-only)["']/g;
const typeOnlyImport = /import\s+type\s+[^;]*?from\s+["'][^"']+["']/g;

const SECRET_NAME =
	/(SECRET|TOKEN|PASSWORD|DATABASE|ACCESS_KEY|API_KEY|PRIVATE|CREDENTIAL)/;

describe("Phase S8: server/client boundary", () => {
	it("finds the server and client module sets", () => {
		expect(serverModules.length).toBeGreaterThan(10);
		expect(clientModules.length).toBeGreaterThan(0);
	});

	it("marks every server module with the server-only guard", () => {
		const unguarded = serverModules.filter(
			(file) =>
				!/^import\s+["']server-only["'];/m.test(readFileSync(file, "utf8")),
		);
		expect(unguarded.map(rel)).toEqual([]);
	});

	it("guards the validated environment module itself", () => {
		const source = readFileSync(join(srcRoot, "env.ts"), "utf8");
		expect(source).toMatch(/^import\s+["']server-only["'];/m);
		expect(source).toMatch(/client:\s*\{\s*\}/);
	});

	it("keeps client modules free of runtime server or environment imports", () => {
		const violations: string[] = [];
		for (const file of clientModules) {
			const source = readFileSync(file, "utf8");
			const typeOnly = new Set(source.match(typeOnlyImport) ?? []);
			for (const match of source.matchAll(serverSpecifier)) {
				const statementStart = source.lastIndexOf("import", match.index);
				const statement = source.slice(
					statementStart,
					match.index + match[0].length,
				);
				if (typeOnly.has(statement)) continue;
				violations.push(`${rel(file)} -> ${match[1]}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("keeps secret-bearing process.env reads out of client modules", () => {
		const violations: string[] = [];
		for (const file of clientModules) {
			for (const match of readFileSync(file, "utf8").matchAll(
				/process\.env\.([A-Za-z0-9_]+)/g,
			)) {
				violations.push(`${rel(file)} -> ${match[1]}`);
			}
		}
		expect(violations).toEqual([]);
	});

	it("never exposes a secret-shaped variable through the NEXT_PUBLIC_ prefix", () => {
		const violations: string[] = [];
		// Test files intentionally reference rejected names to prove they are rejected.
		for (const file of allSourceFiles.filter((entry) => !isTest(entry))) {
			for (const match of readFileSync(file, "utf8").matchAll(
				/NEXT_PUBLIC_[A-Za-z0-9_]+/g,
			)) {
				if (SECRET_NAME.test(match[0]))
					violations.push(`${rel(file)} -> ${match[0]}`);
			}
		}
		expect(violations).toEqual([]);
		const example = readFileSync(join(webRoot, ".env.example"), "utf8");
		expect(example).not.toMatch(
			/NEXT_PUBLIC_[A-Za-z0-9_]*(SECRET|TOKEN|KEY|PASSWORD)/,
		);
	});

	it("routes browser traffic through the oRPC endpoint with a type-only router import", () => {
		const source = readFileSync(join(srcRoot, "lib", "orpc.ts"), "utf8");
		expect(source).toMatch(
			/import\s+type\s+\{\s*AppRouter\s*\}\s+from\s+"@\/server\/orpc\/router"/,
		);
		expect(source).toContain("/api/rpc");
	});
});
