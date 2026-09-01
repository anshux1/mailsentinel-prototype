import "server-only";

import {
	HeadBucketCommand,
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

export async function checkEvidenceStorage(): Promise<void> {
	await evidenceStorage.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
}

export async function putEvidence(input: {
	objectKey: string;
	body: Uint8Array;
	sha256: string;
}): Promise<void> {
	assertEvidenceObjectKey(input.objectKey);
	if (!/^[0-9a-fA-F]{64}$/.test(input.sha256))
		throw new Error("invalid evidence digest");
	if (input.body.byteLength <= 0 || input.body.byteLength > env.MAX_EML_BYTES) {
		throw new Error("evidence exceeds the configured size limit");
	}
	await evidenceStorage.send(
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: input.objectKey,
			Body: input.body,
			ContentLength: input.body.byteLength,
			ContentType: "message/rfc822",
			Metadata: { sha256: input.sha256 },
		}),
	);
}
