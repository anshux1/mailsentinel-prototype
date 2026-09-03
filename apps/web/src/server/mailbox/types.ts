import "server-only";

import type { Repositories } from "@mailsentinel/db";
import type { AnalyzerClient } from "@/server/analyzer-client";
import type { EvidenceStorage } from "@/server/storage/s3";

export class GmailError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "GmailError";
	}
}

export class GmailAuthError extends GmailError {
	constructor(
		message = "Gmail authentication failed or token expired",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "GmailAuthError";
	}
}

export class GmailRateLimitError extends GmailError {
	public readonly retryAfterMs: number;

	constructor(
		message = "Gmail rate limit or quota exceeded",
		retryAfterMs = 1000,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "GmailRateLimitError";
		this.retryAfterMs = retryAfterMs;
	}
}

export class GmailHistoryExpiredError extends GmailError {
	constructor(
		message = "Gmail history cursor is expired or invalid",
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "GmailHistoryExpiredError";
	}
}

export interface GmailMessageSummary {
	id: string;
	threadId?: string;
}

export interface GmailRawMessage {
	id: string;
	raw: string; // Base64URL-encoded RFC 2822
	historyId?: string;
	internalDate?: string;
}

export interface GmailProfile {
	emailAddress: string;
	messagesTotal?: number;
	historyId?: string;
}

export interface GmailTokenResponse {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scope?: string;
	tokenType?: string;
}

export interface GmailClient {
	exchangeCode(params: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GmailTokenResponse>;

	refreshAccessToken(params: {
		refreshToken: string;
	}): Promise<{ accessToken: string; expiresIn?: number }>;

	getProfile(params: { accessToken: string }): Promise<GmailProfile>;

	listMessages(params: {
		accessToken: string;
		q?: string;
		labelIds?: string[];
		maxResults?: number;
		pageToken?: string;
	}): Promise<{
		messages: GmailMessageSummary[];
		nextPageToken?: string;
		resultSizeEstimate?: number;
	}>;

	listHistory(params: {
		accessToken: string;
		startHistoryId: string;
		maxResults?: number;
		pageToken?: string;
	}): Promise<{
		history?: Array<{
			messagesAdded?: Array<{ message: { id: string } }>;
		}>;
		historyId?: string;
		nextPageToken?: string;
	}>;

	getMessageRaw(params: {
		accessToken: string;
		messageId: string;
	}): Promise<GmailRawMessage>;
}

export interface MailboxSyncOptions {
	organizationId: string;
	connectionId: string;
	caseId: string;
	maxMessages?: number;
	label?: string;
	startDate?: string | Date;
	endDate?: string | Date;
	actorUserId?: string | null;
	requestId?: string;
	repos?: Repositories;
	storage?: EvidenceStorage;
	analyzerClient?: AnalyzerClient;
	gmailClient?: GmailClient;
	encryptionKey?: string | Buffer;
}

export interface MailboxSyncResult {
	batchId: string;
	status: "ready" | "partial" | "failed";
	messageCount: number;
	readyCount: number;
	failedCount: number;
	failureReason?: string | null;
}
