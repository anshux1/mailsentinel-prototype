import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { formatLogEntry, logger } from "./logger";

function parse(entry: string): Record<string, unknown> {
	return JSON.parse(entry) as Record<string, unknown>;
}

describe("Phase S8: structured server logging", () => {
	it("emits a JSON envelope with level, event, and timestamp", () => {
		const payload = parse(formatLogEntry("info", "analysis.start_dispatched"));
		expect(payload.level).toBe("info");
		expect(payload.event).toBe("analysis.start_dispatched");
		expect(typeof payload.timestamp).toBe("string");
		expect(Number.isNaN(Date.parse(payload.timestamp as string))).toBe(false);
	});

	it("carries request, organization, case, and run correlation identifiers", () => {
		const payload = parse(
			formatLogEntry("info", "analysis.start_dispatched", {
				requestId: "req_01",
				organizationId: "org_01",
				userId: "user_01",
				caseId: "case_01",
				analysisRunId: "run_01",
				evidenceId: "ev_01",
				reportId: "rep_01",
				status: "queued",
			}),
		);
		expect(payload).toMatchObject({
			requestId: "req_01",
			organizationId: "org_01",
			userId: "user_01",
			caseId: "case_01",
			analysisRunId: "run_01",
			evidenceId: "ev_01",
			reportId: "rep_01",
			status: "queued",
		});
	});

	it("omits correlation identifiers that were not supplied", () => {
		const payload = parse(formatLogEntry("debug", "system.health"));
		expect(payload).not.toHaveProperty("requestId");
		expect(payload).not.toHaveProperty("organizationId");
		expect(payload).not.toHaveProperty("userId");
	});

	it("redacts credential, token, and authorization fields", () => {
		const payload = parse(
			formatLogEntry("info", "analyzer.dispatch", {
				analyzerServiceToken: "super-secret-token",
				authorization: "Bearer super-secret-token",
				S3_SECRET_ACCESS_KEY: "storage-secret",
				password: "hunter2",
				sessionCookie: "sid=abc",
				providerCredential: "abc",
			}),
		);
		for (const field of [
			"analyzerServiceToken",
			"authorization",
			"S3_SECRET_ACCESS_KEY",
			"password",
			"sessionCookie",
			"providerCredential",
		]) {
			expect(payload[field]).toBe("[REDACTED]");
		}
		expect(JSON.stringify(payload)).not.toContain("super-secret-token");
		expect(JSON.stringify(payload)).not.toContain("storage-secret");
		expect(JSON.stringify(payload)).not.toContain("hunter2");
	});

	it("redacts private object keys and raw evidence payloads", () => {
		const rawEmail =
			"From: attacker@example.test\r\nSubject: Invoice\r\n\r\nSend credentials";
		const payload = parse(
			formatLogEntry("error", "evidence.upload_failed", {
				requestId: "req_02",
				objectKey: "organizations/org_01/cases/case_01/evidence/artifact",
				idempotencyKey: "upload_01",
				body: rawEmail,
				rawMessage: rawEmail,
				attachmentBytes: rawEmail,
				contentType: "message/rfc822",
			}),
		);
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("attacker@example.test");
		expect(serialized).not.toContain("Send credentials");
		expect(serialized).not.toContain("organizations/org_01");
		expect(payload.objectKey).toBe("[REDACTED]");
		expect(payload.idempotencyKey).toBe("[REDACTED]");
		expect(payload.body).toBe("[REDACTED]");
		expect(payload.rawMessage).toBe("[REDACTED]");
		expect(payload.attachmentBytes).toBe("[REDACTED]");
	});

	it("redacts unsafe keys nested inside objects and arrays", () => {
		const payload = parse(
			formatLogEntry("warn", "analysis.dispatch_failed", {
				artifact: { sha256: "a".repeat(64), objectKey: "private/key" },
				hops: [{ host: "mx.example.test", authToken: "leak" }],
			}),
		);
		const serialized = JSON.stringify(payload);
		expect(serialized).not.toContain("private/key");
		expect(serialized).not.toContain("leak");
		expect(serialized).toContain("a".repeat(64));
		expect(serialized).toContain("mx.example.test");
	});

	it("reduces Error values to a class name without message or stack", () => {
		const cause = new TypeError("connect ECONNREFUSED 10.0.0.5:9000");
		const payload = parse(
			formatLogEntry("error", "storage.write_failed", { failure: cause }),
		);
		expect(payload.failure).toEqual({
			errorClass: "TypeError",
			errorName: "TypeError",
		});
		expect(JSON.stringify(payload)).not.toContain("ECONNREFUSED");
		expect(JSON.stringify(payload)).not.toContain("10.0.0.5");
	});

	it("bounds long strings, wide arrays, and deep objects", () => {
		const payload = parse(
			formatLogEntry("info", "bounds", {
				note: "x".repeat(2000),
				items: Array.from({ length: 100 }, (_, index) => index),
				deep: { a: { b: { c: { d: { e: "too deep" } } } } },
			}),
		);
		expect((payload.note as string).length).toBeLessThanOrEqual(503);
		expect((payload.items as number[]).length).toBe(20);
		expect(JSON.stringify(payload)).toContain("[Truncated]");
		expect(JSON.stringify(payload)).not.toContain("too deep");
	});

	it("writes each level to the matching console channel", () => {
		const channels = {
			debug: vi.spyOn(console, "debug").mockImplementation(() => undefined),
			info: vi.spyOn(console, "info").mockImplementation(() => undefined),
			warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
			error: vi.spyOn(console, "error").mockImplementation(() => undefined),
		};
		try {
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");
			for (const spy of Object.values(channels)) {
				expect(spy).toHaveBeenCalledTimes(1);
				expect(() => parse(spy.mock.calls[0]?.[0] as string)).not.toThrow();
			}
		} finally {
			for (const spy of Object.values(channels)) spy.mockRestore();
		}
	});

	it("merges base context into every child logger call", () => {
		const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
		try {
			logger
				.withContext({ requestId: "req_03", organizationId: "org_03" })
				.info("case.created", { caseId: "case_03" });
			const payload = parse(spy.mock.calls[0]?.[0] as string);
			expect(payload).toMatchObject({
				requestId: "req_03",
				organizationId: "org_03",
				caseId: "case_03",
			});
		} finally {
			spy.mockRestore();
		}
	});
});
