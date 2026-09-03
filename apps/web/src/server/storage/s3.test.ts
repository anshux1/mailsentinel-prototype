import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { S3Client } from "@aws-sdk/client-s3";
import {
	assertEvidenceObjectKey,
	assertEvidenceObjectKeyForScope,
	evidenceObjectKey,
	MemoryEvidenceStorage,
	S3EvidenceStorage,
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

describe("MemoryEvidenceStorage", () => {
	const validSha = "a".repeat(64);
	const validKey = "organizations/org_01/cases/case_01/artifacts/art_01.eml";
	const scope = { organizationId: "org_01", caseId: "case_01" };

	it("stores, retrieves metadata, and deletes evidence deterministically", async () => {
		const storage = new MemoryEvidenceStorage();
		const body = new TextEncoder().encode(
			"From: alice@example.com\r\n\r\nHello",
		);

		expect(
			await storage.headEvidence({ objectKey: validKey, ...scope }),
		).toBeNull();
		expect(storage.hasObject(validKey)).toBe(false);

		await storage.putEvidence({
			objectKey: validKey,
			...scope,
			body,
			sha256: validSha,
		});

		expect(storage.hasObject(validKey)).toBe(true);
		const head = await storage.headEvidence({ objectKey: validKey, ...scope });
		expect(head).toEqual({
			byteSize: body.byteLength,
			sha256: validSha,
			contentType: "message/rfc822",
		});

		await storage.deleteEvidence({ objectKey: validKey, ...scope });
		expect(storage.hasObject(validKey)).toBe(false);
		expect(
			await storage.headEvidence({ objectKey: validKey, ...scope }),
		).toBeNull();
	});

	it("rejects invalid sha256 hex", async () => {
		const storage = new MemoryEvidenceStorage();
		const body = new Uint8Array([1, 2, 3]);

		await expect(
			storage.putEvidence({
				objectKey: validKey,
				...scope,
				body,
				sha256: "not-a-valid-sha256",
			}),
		).rejects.toThrow("invalid evidence digest");
	});

	it("rejects empty body (0 bytes)", async () => {
		const storage = new MemoryEvidenceStorage();

		await expect(
			storage.putEvidence({
				objectKey: validKey,
				...scope,
				body: new Uint8Array(0),
				sha256: validSha,
			}),
		).rejects.toThrow("evidence exceeds the configured size limit");
	});

	it("rejects oversized body exceeding MAX_EML_BYTES", async () => {
		const storage = new MemoryEvidenceStorage();
		// Create a mock view with byteLength > MAX_EML_BYTES without allocating 26MB
		const fakeOversized = {
			byteLength: 30_000_000,
			[Symbol.iterator]: [][Symbol.iterator],
		} as unknown as Uint8Array;

		await expect(
			storage.putEvidence({
				objectKey: validKey,
				...scope,
				body: fakeOversized,
				sha256: validSha,
			}),
		).rejects.toThrow("evidence exceeds the configured size limit");
	});

	it("rejects storage operations outside requested scope", async () => {
		const storage = new MemoryEvidenceStorage();
		const body = new Uint8Array([1, 2, 3]);

		await expect(
			storage.putEvidence({
				objectKey: validKey,
				organizationId: "other_org",
				caseId: "case_01",
				body,
				sha256: validSha,
			}),
		).rejects.toThrow("evidence object key is outside the requested scope");
	});

	it("simulates put, delete, and head failures for compensation tests", async () => {
		const storage = new MemoryEvidenceStorage();
		const body = new Uint8Array([1, 2, 3]);

		storage.simulatePutFailure = true;
		await expect(
			storage.putEvidence({
				objectKey: validKey,
				...scope,
				body,
				sha256: validSha,
			}),
		).rejects.toThrow("Simulated storage write failure");
		storage.simulatePutFailure = false;

		await storage.putEvidence({
			objectKey: validKey,
			...scope,
			body,
			sha256: validSha,
		});

		storage.simulateHeadFailure = true;
		await expect(
			storage.headEvidence({ objectKey: validKey, ...scope }),
		).rejects.toThrow("Simulated storage head failure");
		storage.simulateHeadFailure = false;

		storage.simulateDeleteFailure = true;
		await expect(
			storage.deleteEvidence({ objectKey: validKey, ...scope }),
		).rejects.toThrow("Simulated storage delete failure");
	});
});

describe("S3EvidenceStorage", () => {
	const validSha = "b".repeat(64);
	const validKey = "organizations/org_01/cases/case_01/artifacts/art_01.eml";
	const scope = { organizationId: "org_01", caseId: "case_01" };

	it("dispatches PutObjectCommand with message/rfc822 and sha256 metadata", async () => {
		const mockSend = vi.fn().mockResolvedValue({});
		const mockClient = { send: mockSend } as unknown as S3Client;
		const storage = new S3EvidenceStorage(mockClient, "test-bucket");
		const body = new Uint8Array([10, 20, 30]);

		await storage.putEvidence({
			objectKey: validKey,
			...scope,
			body,
			sha256: validSha,
		});

		expect(mockSend).toHaveBeenCalledTimes(1);
		const command = mockSend.mock.calls[0]?.[0];
		expect(command.input).toMatchObject({
			Bucket: "test-bucket",
			Key: validKey,
			ContentType: "message/rfc822",
			ContentLength: 3,
			Metadata: { sha256: validSha },
		});
	});

	it("dispatches DeleteObjectCommand for object cleanup", async () => {
		const mockSend = vi.fn().mockResolvedValue({});
		const mockClient = { send: mockSend } as unknown as S3Client;
		const storage = new S3EvidenceStorage(mockClient, "test-bucket");

		await storage.deleteEvidence({ objectKey: validKey, ...scope });
		expect(mockSend).toHaveBeenCalledTimes(1);
		const command = mockSend.mock.calls[0]?.[0];
		expect(command.input).toMatchObject({
			Bucket: "test-bucket",
			Key: validKey,
		});
	});

	it("returns metadata on headEvidence", async () => {
		const mockSend = vi.fn().mockResolvedValue({
			ContentLength: 1234,
			ContentType: "message/rfc822",
			Metadata: { sha256: validSha },
		});
		const mockClient = { send: mockSend } as unknown as S3Client;
		const storage = new S3EvidenceStorage(mockClient, "test-bucket");

		const result = await storage.headEvidence({
			objectKey: validKey,
			...scope,
		});
		expect(result).toEqual({
			byteSize: 1234,
			contentType: "message/rfc822",
			sha256: validSha,
		});
	});

	it("returns null when headEvidence encounters NotFound or NoSuchKey (404)", async () => {
		const notFoundError = new Error("Not Found");
		notFoundError.name = "NotFound";
		(
			notFoundError as unknown as { $metadata: { httpStatusCode: number } }
		).$metadata = {
			httpStatusCode: 404,
		};

		const mockSend = vi.fn().mockRejectedValue(notFoundError);
		const mockClient = { send: mockSend } as unknown as S3Client;
		const storage = new S3EvidenceStorage(mockClient, "test-bucket");

		const result = await storage.headEvidence({
			objectKey: validKey,
			...scope,
		});
		expect(result).toBeNull();
	});

	it("rethrows non-404 errors during headEvidence", async () => {
		const forbiddenError = new Error("Access Denied");
		forbiddenError.name = "AccessDenied";
		(
			forbiddenError as unknown as { $metadata: { httpStatusCode: number } }
		).$metadata = {
			httpStatusCode: 403,
		};

		const mockSend = vi.fn().mockRejectedValue(forbiddenError);
		const mockClient = { send: mockSend } as unknown as S3Client;
		const storage = new S3EvidenceStorage(mockClient, "test-bucket");

		await expect(
			storage.headEvidence({ objectKey: validKey, ...scope }),
		).rejects.toThrow("Access Denied");
	});
});
