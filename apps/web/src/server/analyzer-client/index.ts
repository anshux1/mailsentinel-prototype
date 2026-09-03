import "server-only";

import type {
	AnalysisIntakeAccepted,
	AnalysisIntakeRequest,
	SegmentationRequest,
	SegmentationResult,
} from "@mailsentinel/contracts";
import { env } from "@/env";
import { DependencyError } from "@/server/orpc/errors";

export interface DispatchIntakeInput {
	request: AnalysisIntakeRequest;
	requestId?: string;
	signal?: AbortSignal;
}

export interface DispatchIntakeResult {
	analysisRunId: string;
	status: AnalysisIntakeAccepted["status"];
}

export interface SegmentEvidenceInput {
	request: SegmentationRequest;
	requestId?: string;
	signal?: AbortSignal;
}

export interface AnalyzerClient {
	dispatchIntake(input: DispatchIntakeInput): Promise<DispatchIntakeResult>;
	segmentEvidence(input: SegmentEvidenceInput): Promise<SegmentationResult>;
}

export class AnalyzerError extends DependencyError {
	constructor(
		message: string,
		public readonly statusCode?: number,
		options?: ErrorOptions,
	) {
		super(message, "analyzer", undefined, options);
		this.name = "AnalyzerError";
	}
}

export class AnalyzerAuthError extends DependencyError {
	constructor(message = "Analyzer service authentication failed") {
		super(message, "analyzer");
		this.name = "AnalyzerAuthError";
	}
}

export class AnalyzerValidationError extends DependencyError {
	constructor(message = "Analyzer service rejected intake payload as invalid") {
		super(message, "analyzer");
		this.name = "AnalyzerValidationError";
	}
}

export class AnalyzerUnavailableError extends DependencyError {
	constructor(message = "Analyzer service is unavailable") {
		super(message, "analyzer");
		this.name = "AnalyzerUnavailableError";
	}
}

export class AnalyzerTimeoutError extends DependencyError {
	constructor(message = "Analyzer service request timed out") {
		super(message, "analyzer");
		this.name = "AnalyzerTimeoutError";
	}
}

export class HttpAnalyzerClient implements AnalyzerClient {
	constructor(
		private readonly baseUrl: string = env.ANALYZER_INTERNAL_URL,
		private readonly serviceToken: string = env.ANALYZER_SERVICE_TOKEN,
		private readonly timeoutMs: number = 10_000,
	) {}

	async dispatchIntake(
		input: DispatchIntakeInput,
	): Promise<DispatchIntakeResult> {
		const url = new URL("/v1/analyses", this.baseUrl).toString();
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.serviceToken}`,
		};
		if (input.requestId) {
			headers["x-request-id"] = input.requestId;
		}

		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const combinedSignal = input.signal
			? AbortSignal.any([input.signal, timeoutSignal])
			: timeoutSignal;

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(input.request),
				signal: combinedSignal,
			});
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				(err.name === "TimeoutError" || err.name === "AbortError")
			) {
				throw new AnalyzerTimeoutError();
			}
			throw new AnalyzerUnavailableError();
		}

		if (response.status === 202) {
			let data: unknown;
			try {
				data = await response.json();
			} catch {
				throw new AnalyzerValidationError(
					"Analyzer service returned malformed intake response",
				);
			}

			if (!data || typeof data !== "object" || Array.isArray(data)) {
				throw new AnalyzerValidationError(
					"Analyzer service returned malformed intake response",
				);
			}

			const record = data as Record<string, unknown>;
			const analysisRunId =
				typeof record.analysisRunId === "string"
					? record.analysisRunId
					: typeof record.analysis_run_id === "string"
						? record.analysis_run_id
						: null;
			const status = record.status;

			if (!analysisRunId || analysisRunId !== input.request.analysisRunId) {
				throw new AnalyzerValidationError(
					"Analyzer service returned mismatched analysisRunId in intake response",
				);
			}

			if (status !== "accepted" && status !== "queued") {
				throw new AnalyzerValidationError(
					"Analyzer service returned unacceptable status in intake response",
				);
			}

			return {
				analysisRunId,
				status,
			};
		}

		if (response.status === 401) {
			throw new AnalyzerAuthError();
		}

		if (response.status === 422) {
			throw new AnalyzerValidationError();
		}

		if (
			response.status === 502 ||
			response.status === 503 ||
			response.status === 504
		) {
			throw new AnalyzerUnavailableError();
		}

		throw new AnalyzerError(
			`Analyzer returned unexpected status ${response.status}`,
			response.status,
		);
	}

	async segmentEvidence(
		input: SegmentEvidenceInput,
	): Promise<SegmentationResult> {
		const url = new URL("/v1/evidence/segment", this.baseUrl).toString();
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.serviceToken}`,
		};
		if (input.requestId) {
			headers["x-request-id"] = input.requestId;
		}

		const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
		const combinedSignal = input.signal
			? AbortSignal.any([input.signal, timeoutSignal])
			: timeoutSignal;

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(input.request),
				signal: combinedSignal,
			});
		} catch (err: unknown) {
			if (
				err instanceof Error &&
				(err.name === "TimeoutError" || err.name === "AbortError")
			) {
				throw new AnalyzerTimeoutError();
			}
			throw new AnalyzerUnavailableError();
		}

		if (response.status === 200) {
			try {
				const data = (await response.json()) as SegmentationResult;
				return data;
			} catch {
				throw new AnalyzerValidationError(
					"Analyzer service returned malformed segmentation response",
				);
			}
		}

		if (response.status === 401) {
			throw new AnalyzerAuthError();
		}

		if (response.status === 422) {
			throw new AnalyzerValidationError(
				"Analyzer service rejected segmentation payload as invalid",
			);
		}

		if (
			response.status === 502 ||
			response.status === 503 ||
			response.status === 504
		) {
			throw new AnalyzerUnavailableError();
		}

		throw new AnalyzerError(
			`Analyzer returned unexpected status ${response.status}`,
			response.status,
		);
	}
}

export interface DispatchedIntake {
	request: AnalysisIntakeRequest;
	requestId?: string;
	timestamp: Date;
}

export class MemoryAnalyzerClient implements AnalyzerClient {
	public dispatched: DispatchedIntake[] = [];
	public simulateStatus: 202 | 401 | 422 | 503 | "timeout" | "unavailable" =
		202;
	public customAcceptedStatus: AnalysisIntakeAccepted["status"] = "accepted";
	public simulateDelayMs = 0;
	public onBeforeDispatch?: (
		request: AnalysisIntakeRequest,
	) => Promise<void> | void;

	public segmentResult: SegmentationResult | null = null;
	public simulateSegmentStatus:
		| 200
		| 401
		| 422
		| 503
		| "timeout"
		| "unavailable" = 200;

	async dispatchIntake(
		input: DispatchIntakeInput,
	): Promise<DispatchIntakeResult> {
		if (this.simulateDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.simulateDelayMs));
		}

		if (this.onBeforeDispatch) {
			await this.onBeforeDispatch(input.request);
		}

		if (this.simulateStatus === 401) {
			throw new AnalyzerAuthError();
		}
		if (this.simulateStatus === 422) {
			throw new AnalyzerValidationError();
		}
		if (this.simulateStatus === 503 || this.simulateStatus === "unavailable") {
			throw new AnalyzerUnavailableError();
		}
		if (this.simulateStatus === "timeout") {
			throw new AnalyzerTimeoutError();
		}

		this.dispatched.push({
			request: { ...input.request },
			requestId: input.requestId,
			timestamp: new Date(),
		});

		return {
			analysisRunId: input.request.analysisRunId,
			status: this.customAcceptedStatus,
		};
	}

	async segmentEvidence(
		_input: SegmentEvidenceInput,
	): Promise<SegmentationResult> {
		if (this.simulateDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.simulateDelayMs));
		}

		if (this.simulateSegmentStatus === 401) {
			throw new AnalyzerAuthError();
		}
		if (this.simulateSegmentStatus === 422) {
			throw new AnalyzerValidationError();
		}
		if (
			this.simulateSegmentStatus === 503 ||
			this.simulateSegmentStatus === "unavailable"
		) {
			throw new AnalyzerUnavailableError();
		}
		if (this.simulateSegmentStatus === "timeout") {
			throw new AnalyzerTimeoutError();
		}

		if (this.segmentResult) {
			return this.segmentResult;
		}

		return {
			containerFormat: "single",
			messageCount: 1,
			segments: [
				{
					index: 0,
					byteOffset: 0,
					byteLength: 0,
					sha256: "0".repeat(64),
				},
			],
		};
	}

	clear(): void {
		this.dispatched = [];
		this.simulateStatus = 202;
		this.customAcceptedStatus = "accepted";
		this.simulateDelayMs = 0;
		this.onBeforeDispatch = undefined;
		this.segmentResult = null;
		this.simulateSegmentStatus = 200;
	}
}

/** Server-only singleton client for production. */
export const defaultAnalyzerClient = new HttpAnalyzerClient();

/** Backwards-compatible alias. */
export const analyzerClient = defaultAnalyzerClient;
