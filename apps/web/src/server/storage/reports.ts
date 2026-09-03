import "server-only";

import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/env";
import { evidenceStorage } from "./s3";

const safeId = /^[A-Za-z0-9_-]+$/;
const reportKeyPattern =
	/^organizations\/[A-Za-z0-9_-]+\/cases\/[A-Za-z0-9_-]+\/reports\/[A-Za-z0-9_-]+\/v[1-9][0-9]*\.(json|html|txt)$/;

export type GeneratedReportFormat = "json" | "html" | "text";

export function reportObjectKey(input: {
	organizationId: string;
	caseId: string;
	analysisRunId: string;
	version: number;
	format: GeneratedReportFormat;
}): string {
	if (
		!safeId.test(input.organizationId) ||
		!safeId.test(input.caseId) ||
		!safeId.test(input.analysisRunId) ||
		!Number.isSafeInteger(input.version) ||
		input.version < 1
	) {
		throw new Error("Invalid report storage scope");
	}
	const extension = input.format === "text" ? "txt" : input.format;
	return `organizations/${input.organizationId}/cases/${input.caseId}/reports/${input.analysisRunId}/v${input.version}.${extension}`;
}

function assertReportScope(
	objectKey: string,
	scope: { organizationId: string; caseId: string; analysisRunId: string },
): void {
	if (
		!reportKeyPattern.test(objectKey) ||
		!objectKey.startsWith(
			`organizations/${scope.organizationId}/cases/${scope.caseId}/reports/${scope.analysisRunId}/`,
		)
	) {
		throw new Error("Report object is outside the requested scope");
	}
}

export interface ReportStorage {
	put(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
		analysisRunId: string;
		content: string;
		contentType: string;
	}): Promise<void>;
	get(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
		analysisRunId: string;
	}): Promise<string | null>;
	delete(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
		analysisRunId: string;
	}): Promise<void>;
}

export class S3ReportStorage implements ReportStorage {
	constructor(
		private readonly client: S3Client = evidenceStorage,
		private readonly bucket = env.S3_BUCKET,
	) {}

	async put(input: Parameters<ReportStorage["put"]>[0]): Promise<void> {
		assertReportScope(input.objectKey, input);
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: input.objectKey,
				Body: input.content,
				ContentType: input.contentType,
				ContentLength: Buffer.byteLength(input.content, "utf8"),
				IfNoneMatch: "*",
			}),
		);
	}

	async get(
		input: Parameters<ReportStorage["get"]>[0],
	): Promise<string | null> {
		assertReportScope(input.objectKey, input);
		try {
			const response = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: input.objectKey }),
			);
			return response.Body
				? await response.Body.transformToString("utf-8")
				: null;
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				(("name" in error &&
					(error.name === "NoSuchKey" || error.name === "NotFound")) ||
					("$metadata" in error &&
						(error as { $metadata?: { httpStatusCode?: number } }).$metadata
							?.httpStatusCode === 404))
			) {
				return null;
			}
			throw error;
		}
	}

	async delete(input: Parameters<ReportStorage["delete"]>[0]): Promise<void> {
		assertReportScope(input.objectKey, input);
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: input.objectKey }),
		);
	}
}

export class MemoryReportStorage implements ReportStorage {
	readonly objects = new Map<string, string>();
	failPut = false;
	failGet = false;
	failDelete = false;

	async put(input: Parameters<ReportStorage["put"]>[0]): Promise<void> {
		assertReportScope(input.objectKey, input);
		if (this.failPut) throw new Error("Simulated report storage failure");
		if (this.objects.has(input.objectKey))
			throw new Error("Report object already exists");
		this.objects.set(input.objectKey, input.content);
	}

	async get(
		input: Parameters<ReportStorage["get"]>[0],
	): Promise<string | null> {
		assertReportScope(input.objectKey, input);
		if (this.failGet) throw new Error("Simulated report read failure");
		return this.objects.get(input.objectKey) ?? null;
	}

	async delete(input: Parameters<ReportStorage["delete"]>[0]): Promise<void> {
		assertReportScope(input.objectKey, input);
		if (this.failDelete) throw new Error("Simulated report delete failure");
		this.objects.delete(input.objectKey);
	}
}

export const defaultReportStorage: ReportStorage = new S3ReportStorage();
