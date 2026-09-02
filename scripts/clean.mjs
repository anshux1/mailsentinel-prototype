import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectories = ["apps", "packages"];
const removableNames = [
	"node_modules",
	".turbo",
	".next",
	"out",
	"dist",
	"build",
	"coverage",
	"playwright-report",
	"test-results",
];

function remove(path) {
	rmSync(path, { force: true, recursive: true });
	console.log(`Removed ${path}`);
}

remove(join(root, "node_modules"));
remove(join(root, ".turbo"));

for (const workspaceDirectory of workspaceDirectories) {
	const directory = join(root, workspaceDirectory);
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		for (const removableName of removableNames) {
			remove(join(directory, entry.name, removableName));
		}
	}
}
