import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	assertEvidenceObjectKey,
	assertEvidenceObjectKeyForScope,
	evidenceObjectKey,
} from "./s3";

describe("evidence object keys", () => {
	it("uses scoped opaque artifact identifiers", () => {
		expect(
			evidenceObjectKey({
				organizationId: "org_01",
				caseId: "case_01",
				artifactId: "artifact_01",
			}),
		).toBe("organizations/org_01/cases/case_01/artifacts/artifact_01.eml");
	});

	it.each([
		"../artifact",
		"artifact/../../secret",
		"artifact with spaces",
	])("rejects unsafe artifact identifiers: %s", (artifactId) =>
		expect(() =>
			evidenceObjectKey({
				organizationId: "org_01",
				caseId: "case_01",
				artifactId,
			}),
		).toThrow());

	it("rejects unscoped keys", () =>
		expect(() => assertEvidenceObjectKey("public/artifact.eml")).toThrow());

	it("rejects a key from another tenant or case", () =>
		expect(() =>
			assertEvidenceObjectKeyForScope(
				"organizations/org_other/cases/case_01/artifacts/artifact_01.eml",
				{ organizationId: "org_01", caseId: "case_01" },
			),
		).toThrow());
});
