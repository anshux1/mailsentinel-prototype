import { describe, expect, it } from "vitest";
import { type CaseShell, MemoryCaseRepository } from "./repositories.js";

const now = new Date("2026-01-01T00:00:00Z");
const records: CaseShell[] = [
	{ id: "case_a", organizationId: "org_a", title: "A", createdAt: now, updatedAt: now },
	{ id: "case_b", organizationId: "org_b", title: "B", createdAt: now, updatedAt: now },
];

describe("tenant-scoped case repository", () => {
	it("never returns another organization's case by id", async () => {
		const repository = new MemoryCaseRepository(records);
		await expect(repository.getCase({ organizationId: "org_a", caseId: "case_b" })).resolves.toBeNull();
	});

	it("filters lists by organization", async () => {
		const repository = new MemoryCaseRepository(records);
		const result = await repository.listCases({ organizationId: "org_a" });
		expect(result.map(({ id }) => id)).toEqual(["case_a"]);
	});
});
