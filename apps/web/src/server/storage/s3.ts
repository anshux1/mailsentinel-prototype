import "server-only";

import {
	HeadBucketCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@/env";

const credentials =
	env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
		? {
				accessKeyId: env.S3_ACCESS_KEY_ID,
				secretAccessKey: env.S3_SECRET_ACCESS_KEY,
			}
		: undefined;

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
	return `organizations/${input.organizationId}/cases/${input.caseId}/artifacts/${input.artifactId}.eml`;
}

export async function checkEvidenceStorage(): Promise<void> {
	await evidenceStorage.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
}

export async function putEvidence(input: {
	objectKey: string;
	body: Uint8Array;
	sha256: string;
}): Promise<void> {
	await evidenceStorage.send(
		new PutObjectCommand({
			Bucket: env.S3_BUCKET,
			Key: input.objectKey,
			Body: input.body,
			ContentType: "message/rfc822",
			Metadata: { sha256: input.sha256 },
		}),
	);
}
