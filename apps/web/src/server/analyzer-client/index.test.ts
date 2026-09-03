import type { AnalysisIntakeRequest } from "@mailsentinel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
	AnalyzerAuthError,
	AnalyzerTimeoutError,
	AnalyzerUnavailableError,
	AnalyzerValidationError,
	HttpAnalyzerClient,
	MemoryAnalyzerClient,
} from "./index";

describe("Analyzer Client Abstraction", () => {
	const dummyServiceToken = "super-secret-service-token-123456";
	const dummyBaseUrl = "http://analyzer.internal:8000";

	const sampleRequest: AnalysisIntakeRequest = {
		analysisRunId: "run_test_001",
		caseId: "case_test_001",
		organizationId: "org_test_001",
		requestedAt: "2026-09-03T12:00:00.000Z",
		artifact: {
			objectKey:
				"organizations/org_test_001/cases/case_test_001/artifacts/art_001.eml",
			sha256:
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			byteSize: 1024,
			digestAlgorithm: "sha256",
		},
	};

	describe("HttpAnalyzerClient", () => {
		const originalFetch = globalThis.fetch;

		beforeEach(() => {
			vi.restoreAllMocks();
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
		});

		it("dispatches POST /v1/analyses with authorization header, request id, and body", async () => {
			let capturedUrl = "";
			let capturedInit: RequestInit | undefined;

			globalThis.fetch = vi.fn().mockImplementation(async (url, init) => {
				capturedUrl = String(url);
				capturedInit = init;
				return new Response(
					JSON.stringify({
						analysisRunId: "run_test_001",
						status: "accepted",
					}),
					{
						status: 202,
						headers: { "Content-Type": "application/json" },
					},
				);
			});

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			const result = await client.dispatchIntake({
				request: sampleRequest,
				requestId: "req_dispatch_123",
			});

			expect(capturedUrl).toBe("http://analyzer.internal:8000/v1/analyses");
			expect(capturedInit?.method).toBe("POST");

			const headers = capturedInit?.headers as Record<string, string>;
			expect(headers.Authorization).toBe(`Bearer ${dummyServiceToken}`);
			expect(headers["x-request-id"]).toBe("req_dispatch_123");
			expect(headers["Content-Type"]).toBe("application/json");

			const sentBody = JSON.parse(String(capturedInit?.body));
			expect(sentBody).toEqual(sampleRequest);

			expect(result).toEqual({
				analysisRunId: "run_test_001",
				status: "accepted",
			});
		});

		it("handles exact 202 accepted response", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						analysisRunId: "run_test_001",
						status: "accepted",
					}),
					{
						status: 202,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			const result = await client.dispatchIntake({ request: sampleRequest });
			expect(result.status).toBe("accepted");
			expect(result.analysisRunId).toBe("run_test_001");
		});

		it("handles exact 202 queued response", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						analysisRunId: "run_test_001",
						status: "queued",
					}),
					{
						status: 202,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			const result = await client.dispatchIntake({ request: sampleRequest });
			expect(result.status).toBe("queued");
			expect(result.analysisRunId).toBe("run_test_001");
		});

		it("rejects 202 response with malformed unparseable JSON as safe AnalyzerValidationError", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response("invalid json {", {
					status: 202,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			let error: unknown;
			try {
				await client.dispatchIntake({ request: sampleRequest });
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(AnalyzerValidationError);
			expect(JSON.stringify(error)).not.toContain("invalid json {");
			expect(error).not.toHaveProperty("validationDetails");
		});

		it("rejects 202 response with non-object JSON shape", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify(["array_not_object"]), {
					status: 202,
					headers: { "Content-Type": "application/json" },
				}),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			await expect(
				client.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerValidationError);
		});

		it("rejects 202 response with mismatched analysisRunId as safe AnalyzerValidationError", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						analysisRunId: "run_DIFFERENT_999",
						status: "accepted",
					}),
					{
						status: 202,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			let error: unknown;
			try {
				await client.dispatchIntake({ request: sampleRequest });
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(AnalyzerValidationError);
			expect(JSON.stringify(error)).not.toContain("run_DIFFERENT_999");
		});

		it("rejects 202 response with unacceptable status (e.g. completed, failed, processing)", async () => {
			const unacceptableStatuses = [
				"completed",
				"failed",
				"processing",
				"unknown",
			];
			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);

			for (const badStatus of unacceptableStatuses) {
				globalThis.fetch = vi.fn().mockResolvedValue(
					new Response(
						JSON.stringify({
							analysisRunId: "run_test_001",
							status: badStatus,
						}),
						{
							status: 202,
							headers: { "Content-Type": "application/json" },
						},
					),
				);

				await expect(
					client.dispatchIntake({ request: sampleRequest }),
				).rejects.toBeInstanceOf(AnalyzerValidationError);
			}
		});

		it("handles 401 unauthorized and never leaks service token in error", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(JSON.stringify({ detail: "Invalid service token" }), {
					status: 401,
				}),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			let errorCaught: unknown;
			try {
				await client.dispatchIntake({ request: sampleRequest });
			} catch (err) {
				errorCaught = err;
			}

			expect(errorCaught).toBeInstanceOf(AnalyzerAuthError);
			const err = errorCaught as AnalyzerAuthError;
			expect(err.message).not.toContain(dummyServiceToken);
			expect(JSON.stringify(err)).not.toContain(dummyServiceToken);
		});

		it("handles 422 validation error without retaining raw provider body or validationDetails", async () => {
			const providerSecretPayload = "INTERNAL_ANALYZER_DIAGNOSTIC_DATA_SECRET";
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						detail: providerSecretPayload,
					}),
					{
						status: 422,
						headers: { "Content-Type": "application/json" },
					},
				),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			let errorCaught: unknown;
			try {
				await client.dispatchIntake({ request: sampleRequest });
			} catch (err) {
				errorCaught = err;
			}
			expect(errorCaught).toBeInstanceOf(AnalyzerValidationError);
			expect(errorCaught).not.toHaveProperty("validationDetails");
			expect(JSON.stringify(errorCaught)).not.toContain(providerSecretPayload);
		});

		it("handles 503 service unavailable", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue(
				new Response("Service Unavailable", {
					status: 503,
				}),
			);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			await expect(
				client.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerUnavailableError);
		});

		it("handles timeout error", async () => {
			globalThis.fetch = vi
				.fn()
				.mockRejectedValue(
					new DOMException(
						"The operation was aborted due to timeout",
						"TimeoutError",
					),
				);

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			await expect(
				client.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerTimeoutError);
		});

		it("handles network failure / connection refused", async () => {
			globalThis.fetch = vi
				.fn()
				.mockRejectedValue(new TypeError("fetch failed"));

			const client = new HttpAnalyzerClient(dummyBaseUrl, dummyServiceToken);
			await expect(
				client.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerUnavailableError);
		});
	});

	describe("MemoryAnalyzerClient", () => {
		it("tracks dispatched intake calls and returns accepted status", async () => {
			const memoryClient = new MemoryAnalyzerClient();
			const result = await memoryClient.dispatchIntake({
				request: sampleRequest,
				requestId: "req_mem_1",
			});

			expect(result).toEqual({
				analysisRunId: "run_test_001",
				status: "accepted",
			});
			expect(memoryClient.dispatched).toHaveLength(1);
			expect(memoryClient.dispatched[0]?.request).toEqual(sampleRequest);
			expect(memoryClient.dispatched[0]?.requestId).toBe("req_mem_1");
		});

		it("simulates 401, 422, 503, and timeout", async () => {
			const memoryClient = new MemoryAnalyzerClient();

			memoryClient.simulateStatus = 401;
			await expect(
				memoryClient.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerAuthError);

			memoryClient.simulateStatus = 422;
			await expect(
				memoryClient.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerValidationError);

			memoryClient.simulateStatus = 503;
			await expect(
				memoryClient.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerUnavailableError);

			memoryClient.simulateStatus = "timeout";
			await expect(
				memoryClient.dispatchIntake({ request: sampleRequest }),
			).rejects.toBeInstanceOf(AnalyzerTimeoutError);
		});
	});
});
