import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decryptToken, encryptToken, MailboxCryptoError } from "./crypto";

describe("Mailbox Token Crypto (AES-256-GCM)", () => {
	const testKeyHex =
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
	const sampleToken = "ya29.a0AfH6SMD_sample_google_refresh_token_12345";

	it("encrypts and decrypts refresh token successfully (roundtrip)", () => {
		const encrypted = encryptToken(sampleToken, testKeyHex);
		expect(encrypted.encryptedRefreshToken).toBeDefined();
		expect(encrypted.tokenNonce).toHaveLength(24); // 12 bytes hex

		const decrypted = decryptToken(encrypted, testKeyHex);
		expect(decrypted).toBe(sampleToken);
	});

	it("generates distinct random nonces and ciphertexts for identical plaintext", () => {
		const enc1 = encryptToken(sampleToken, testKeyHex);
		const enc2 = encryptToken(sampleToken, testKeyHex);
		expect(enc1.tokenNonce).not.toBe(enc2.tokenNonce);
		expect(enc1.encryptedRefreshToken).not.toBe(enc2.encryptedRefreshToken);
	});

	it("detects ciphertext tampering and throws MailboxCryptoError", () => {
		const encrypted = encryptToken(sampleToken, testKeyHex);
		// Flip a character in the ciphertext
		const tamperedCiphertext =
			encrypted.encryptedRefreshToken.slice(0, 4) === "0000"
				? `ffff${encrypted.encryptedRefreshToken.slice(4)}`
				: `0000${encrypted.encryptedRefreshToken.slice(4)}`;

		expect(() =>
			decryptToken(
				{
					encryptedRefreshToken: tamperedCiphertext,
					tokenNonce: encrypted.tokenNonce,
				},
				testKeyHex,
			),
		).toThrow(MailboxCryptoError);
	});

	it("detects nonce tampering and throws MailboxCryptoError", () => {
		const encrypted = encryptToken(sampleToken, testKeyHex);
		const tamperedNonce =
			encrypted.tokenNonce.slice(0, 2) === "aa"
				? `bb${encrypted.tokenNonce.slice(2)}`
				: `aa${encrypted.tokenNonce.slice(2)}`;

		expect(() =>
			decryptToken(
				{
					encryptedRefreshToken: encrypted.encryptedRefreshToken,
					tokenNonce: tamperedNonce,
				},
				testKeyHex,
			),
		).toThrow(MailboxCryptoError);
	});

	it("fails decryption when provided a different encryption key", () => {
		const encrypted = encryptToken(sampleToken, testKeyHex);
		const differentKey =
			"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

		expect(() => decryptToken(encrypted, differentKey)).toThrow(
			MailboxCryptoError,
		);
	});

	it("rejects invalid nonce length", () => {
		const encrypted = encryptToken(sampleToken, testKeyHex);
		expect(() =>
			decryptToken(
				{
					encryptedRefreshToken: encrypted.encryptedRefreshToken,
					tokenNonce: "deadbeef", // Only 4 bytes
				},
				testKeyHex,
			),
		).toThrow(MailboxCryptoError);
	});

	it("rejects empty token encryption", () => {
		expect(() => encryptToken("", testKeyHex)).toThrow(MailboxCryptoError);
	});

	it("handles 32-byte raw utf-8 string key", () => {
		const stringKey = "12345678901234567890123456789012";
		const encrypted = encryptToken(sampleToken, stringKey);
		const decrypted = decryptToken(encrypted, stringKey);
		expect(decrypted).toBe(sampleToken);
	});
});
