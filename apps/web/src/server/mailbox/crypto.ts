import "server-only";

import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import { env } from "@/env";

export class MailboxCryptoError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "MailboxCryptoError";
	}
}

export function getEncryptionKey(explicitKey?: string | Buffer): Buffer {
	if (Buffer.isBuffer(explicitKey)) {
		if (explicitKey.length === 32) {
			return explicitKey;
		}
		return createHash("sha256").update(explicitKey).digest();
	}
	const keyStr = explicitKey ?? env.MAILBOX_TOKEN_ENCRYPTION_KEY;
	if (!keyStr) {
		throw new MailboxCryptoError(
			"MAILBOX_TOKEN_ENCRYPTION_KEY is not configured",
		);
	}
	// 64-character hex string -> parse directly to 32 bytes
	if (/^[0-9a-fA-F]{64}$/.test(keyStr)) {
		return Buffer.from(keyStr, "hex");
	}
	const buf = Buffer.from(keyStr, "utf-8");
	if (buf.length === 32) {
		return buf;
	}
	// Hash to 32 bytes
	return createHash("sha256").update(buf).digest();
}

export interface EncryptedTokenResult {
	encryptedRefreshToken: string;
	tokenNonce: string;
}

/**
 * Encrypts a token using AES-256-GCM.
 * Generates a 12-byte random IV.
 * Ciphertext and 16-byte GCM authentication tag are stored together.
 */
export function encryptToken(
	token: string,
	explicitKey?: string | Buffer,
): EncryptedTokenResult {
	if (!token) {
		throw new MailboxCryptoError("Cannot encrypt empty token");
	}

	try {
		const key = getEncryptionKey(explicitKey);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		const ciphertext = Buffer.concat([
			cipher.update(token, "utf8"),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();

		// Append tag directly (last 16 bytes)
		const combined = Buffer.concat([ciphertext, tag]);

		return {
			encryptedRefreshToken: combined.toString("hex"),
			tokenNonce: iv.toString("hex"),
		};
	} catch (err) {
		if (err instanceof MailboxCryptoError) throw err;
		throw new MailboxCryptoError("Failed to encrypt token", { cause: err });
	}
}

/**
 * Decrypts a token using AES-256-GCM.
 * Throws MailboxCryptoError on key mismatch, tampering, or invalid nonce.
 */
export function decryptToken(
	params: { encryptedRefreshToken: string; tokenNonce: string },
	explicitKey?: string | Buffer,
): string {
	try {
		const key = getEncryptionKey(explicitKey);
		const iv = Buffer.from(params.tokenNonce, "hex");
		if (iv.length !== 12) {
			throw new MailboxCryptoError(
				"Invalid token nonce length: expected 12 bytes",
			);
		}

		let ciphertext: Buffer;
		let tag: Buffer;

		if (params.encryptedRefreshToken.includes(":")) {
			const [cHex, tHex] = params.encryptedRefreshToken.split(":");
			ciphertext = Buffer.from(cHex ?? "", "hex");
			tag = Buffer.from(tHex ?? "", "hex");
		} else {
			const combined = Buffer.from(params.encryptedRefreshToken, "hex");
			if (combined.length < 16) {
				throw new MailboxCryptoError(
					"Invalid encrypted token length: missing authentication tag",
				);
			}
			ciphertext = combined.subarray(0, combined.length - 16);
			tag = combined.subarray(combined.length - 16);
		}

		if (tag.length !== 16) {
			throw new MailboxCryptoError(
				"Invalid authentication tag length: expected 16 bytes",
			);
		}

		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);

		const decrypted = Buffer.concat([
			decipher.update(ciphertext),
			decipher.final(),
		]);
		return decrypted.toString("utf8");
	} catch (err) {
		if (err instanceof MailboxCryptoError) throw err;
		throw new MailboxCryptoError(
			"Failed to decrypt token: tampering detected or key mismatch",
			{ cause: err },
		);
	}
}
