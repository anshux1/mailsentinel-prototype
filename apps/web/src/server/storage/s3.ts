import "server-only";

import {
	DeleteObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/env";

const credentials = {
	accessKeyId: env.S3_ACCESS_KEY_ID,
	secretAccessKey: env.S3_SECRET_ACCESS_KEY,
};
const safeIdentifier = /^[A-Za-z0-9_-]+$/;
const evidenceKey =
	/^organizations\/[A-Za-z0-9_-]+\/cases\/[A-Za-z0-9_-]+\/artifacts\/[A-Za-z0-9_-]+\.eml$/;
export const MAX_EML_BYTES = env.MAX_EML_BYTES ?? 26_214_400;
export const MAX_CONTAINER_BYTES = env.MAX_CONTAINER_BYTES ?? 104_857_600;

export const evidenceStorage = new S3Client({
	endpoint: env.S3_ENDPOINT,
	region: env.S3_REGION,
	forcePathStyle: env.S3_FORCE_PATH_STYLE,
	credentials,
});

export function evidenceObjectKey(input: {
	organizationId: string;
	caseId: string;
	artifactId: string;
}): string {
	for (const [name, value] of Object.entries(input)) {
		if (!safeIdentifier.test(value))
			throw new Error(`${name} must be a safe identifier`);
	}
	return `organizations/${input.organizationId}/cases/${input.caseId}/artifacts/${input.artifactId}.eml`;
}

export function assertEvidenceObjectKey(objectKey: string): void {
	if (!evidenceKey.test(objectKey))
		throw new Error("invalid evidence object key");
}

export function assertEvidenceObjectKeyForScope(
	objectKey: string,
	scope: { organizationId: string; caseId: string },
): void {
	assertEvidenceObjectKey(objectKey);
	if (
		!safeIdentifier.test(scope.organizationId) ||
		!safeIdentifier.test(scope.caseId) ||
		!objectKey.startsWith(
			`organizations/${scope.organizationId}/cases/${scope.caseId}/artifacts/`,
		)
	) {
		throw new Error("evidence object key is outside the requested scope");
	}
}

export async function checkEvidenceStorage(): Promise<void> {
	await evidenceStorage.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
}

export interface EvidenceStorage {
	putEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
		body: Uint8Array;
		sha256: string;
		contentType?: string;
	}): Promise<void>;
	deleteEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
	}): Promise<void>;
	headEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
	}): Promise<{
		byteSize: number;
		sha256?: string;
		contentType?: string;
	} | null>;
}

export class S3EvidenceStorage implements EvidenceStorage {
	constructor(
		private readonly client: S3Client = evidenceStorage,
		private readonly bucket: string = env.S3_BUCKET,
	) {}

	async putEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
		body: Uint8Array;
		sha256: string;
		contentType?: string;
	}): Promise<void> {
		assertEvidenceObjectKeyForScope(input.objectKey, input);
		if (!/^[0-9a-fA-F]{64}$/.test(input.sha256))
			throw new Error("invalid evidence digest");
		if (input.body.byteLength <= 0 || input.body.byteLength > MAX_EML_BYTES) {
			throw new Error("evidence exceeds the configured size limit");
		}
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: input.objectKey,
				Body: input.body,
				ContentLength: input.body.byteLength,
				ContentType: input.contentType ?? "message/rfc822",
				Metadata: { sha256: input.sha256.toLowerCase() },
			}),
		);
	}

	async deleteEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
	}): Promise<void> {
		assertEvidenceObjectKeyForScope(input.objectKey, input);
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: input.objectKey,
			}),
		);
	}

	async headEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
	}): Promise<{
		byteSize: number;
		sha256?: string;
		contentType?: string;
	} | null> {
		assertEvidenceObjectKeyForScope(input.objectKey, input);
		try {
			const res = await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: input.objectKey,
				}),
			);
			return {
				byteSize: res.ContentLength ?? 0,
				sha256: res.Metadata?.sha256,
				contentType: res.ContentType,
			};
		} catch (err: unknown) {
			if (
				err &&
				typeof err === "object" &&
				(("name" in err &&
					(err.name === "NotFound" || err.name === "NoSuchKey")) ||
					("$metadata" in err &&
						(err as { $metadata: { httpStatusCode?: number } }).$metadata
							?.httpStatusCode === 404))
			) {
				return null;
			}
			throw err;
		}
	}
}

export class MemoryEvidenceStorage implements EvidenceStorage {
	private readonly objects = new Map<
		string,
		{
			body: Uint8Array;
			sha256: string;
			byteSize: number;
			contentType: string;
			organizationId: string;
			caseId: string;
		}
	>();

	public simulatePutFailure = false;
	public simulatePutFailureAfterWrite = false;
	public simulateDeleteFailure = false;
	public simulateHeadFailure = false;

	constructor(
		initialObjects?: Record<
			string,
			{
				body: Uint8Array;
				sha256: string;
				byteSize: number;
				contentType?: string;
				organizationId: string;
				caseId: string;
			}
		>,
	) {
		if (initialObjects) {
			for (const [key, val] of Object.entries(initialObjects)) {
				this.objects.set(key, {
					body: new Uint8Array(val.body),
					sha256: val.sha256.toLowerCase(),
					byteSize: val.byteSize,
					contentType: val.contentType ?? "message/rfc822",
					organizationId: val.organizationId,
					caseId: val.caseId,
				});
			}
		}
	}

	async putEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
		body: Uint8Array;
		sha256: string;
		contentType?: string;
	}): Promise<void> {
		if (this.simulatePutFailure) {
			throw new Error("Simulated storage write failure");
		}
		assertEvidenceObjectKeyForScope(input.objectKey, input);
		if (!/^[0-9a-fA-F]{64}$/.test(input.sha256))
			throw new Error("invalid evidence digest");
		if (input.body.byteLength <= 0 || input.body.byteLength > MAX_EML_BYTES) {
			throw new Error("evidence exceeds the configured size limit");
		}
		this.objects.set(input.objectKey, {
			body: new Uint8Array(input.body),
			sha256: input.sha256.toLowerCase(),
			byteSize: input.body.byteLength,
			contentType: input.contentType ?? "message/rfc822",
			organizationId: input.organizationId,
			caseId: input.caseId,
		});
		if (this.simulatePutFailureAfterWrite) {
			throw new Error("Simulated lost storage write response");
		}
	}

	async deleteEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
	}): Promise<void> {
		if (this.simulateDeleteFailure) {
			throw new Error("Simulated storage delete failure");
		}
		assertEvidenceObjectKeyForScope(input.objectKey, input);
		this.objects.delete(input.objectKey);
	}

	async headEvidence(input: {
		objectKey: string;
		organizationId: string;
		caseId: string;
	}): Promise<{
		byteSize: number;
		sha256?: string;
		contentType?: string;
	} | null> {
		if (this.simulateHeadFailure) {
			throw new Error("Simulated storage head failure");
		}
		assertEvidenceObjectKeyForScope(input.objectKey, input);
		const obj = this.objects.get(input.objectKey);
		if (!obj) return null;
		return {
			byteSize: obj.byteSize,
			sha256: obj.sha256,
			contentType: obj.contentType,
		};
	}

	hasObject(objectKey: string): boolean {
		return this.objects.has(objectKey);
	}

	getObject(objectKey: string) {
		return this.objects.get(objectKey);
	}

	clear(): void {
		this.objects.clear();
	}
}

export const defaultEvidenceStorage: EvidenceStorage = new S3EvidenceStorage();

export async function putEvidence(input: {
	objectKey: string;
	organizationId: string;
	caseId: string;
	body: Uint8Array;
	sha256: string;
	contentType?: string;
}): Promise<void> {
	return defaultEvidenceStorage.putEvidence(input);
}

export async function deleteEvidence(input: {
	objectKey: string;
	organizationId: string;
	caseId: string;
}): Promise<void> {
	return defaultEvidenceStorage.deleteEvidence(input);
}

export async function headEvidence(input: {
	objectKey: string;
	organizationId: string;
	caseId: string;
}): Promise<{
	byteSize: number;
	sha256?: string;
	contentType?: string;
} | null> {
	return defaultEvidenceStorage.headEvidence(input);
}
