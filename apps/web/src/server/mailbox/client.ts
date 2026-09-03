import "server-only";

import { env } from "@/env";
import {
	GmailAuthError,
	type GmailClient,
	GmailError,
	GmailHistoryExpiredError,
	type GmailMessageSummary,
	type GmailProfile,
	GmailRateLimitError,
	type GmailRawMessage,
	type GmailTokenResponse,
} from "./types";

export interface HttpGmailClientOptions {
	clientId?: string;
	clientSecret?: string;
	baseUrl?: string;
	timeoutMs?: number;
}

export class HttpGmailClient implements GmailClient {
	private readonly clientId: string;
	private readonly clientSecret: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(options?: HttpGmailClientOptions) {
		this.clientId =
			options?.clientId ??
			env.GOOGLE_OAUTH_CLIENT_ID ??
			env.GMAIL_CLIENT_ID ??
			"";
		this.clientSecret =
			options?.clientSecret ??
			env.GOOGLE_OAUTH_CLIENT_SECRET ??
			env.GMAIL_CLIENT_SECRET ??
			"";
		this.baseUrl = options?.baseUrl ?? "https://gmail.googleapis.com";
		this.timeoutMs = options?.timeoutMs ?? 15_000;
	}

	async exchangeCode(params: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GmailTokenResponse> {
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: this.clientSecret,
			code: params.code,
			code_verifier: params.codeVerifier,
			grant_type: "authorization_code",
			redirect_uri: params.redirectUri,
		});

		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			if (res.status === 401 || res.status === 400) {
				throw new GmailAuthError("Authorization code exchange failed");
			}
			throw new GmailError(`Token exchange failed with status ${res.status}`);
		}

		const data = (await res.json()) as {
			access_token: string;
			refresh_token?: string;
			expires_in?: number;
			scope?: string;
			token_type?: string;
		};

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
			scope: data.scope,
			tokenType: data.token_type,
		};
	}

	async refreshAccessToken(params: {
		refreshToken: string;
	}): Promise<{ accessToken: string; expiresIn?: number }> {
		const body = new URLSearchParams({
			client_id: this.clientId,
			client_secret: this.clientSecret,
			refresh_token: params.refreshToken,
			grant_type: "refresh_token",
		});

		const res = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			if (res.status === 400 || res.status === 401) {
				throw new GmailAuthError(
					"Token refresh failed: token revoked or invalid",
				);
			}
			throw new GmailError(`Token refresh failed with status ${res.status}`);
		}

		const data = (await res.json()) as {
			access_token: string;
			expires_in?: number;
		};

		return {
			accessToken: data.access_token,
			expiresIn: data.expires_in,
		};
	}

	async getProfile(params: { accessToken: string }): Promise<GmailProfile> {
		const url = new URL("/gmail/v1/users/me/profile", this.baseUrl);
		const res = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${params.accessToken}`,
			},
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			if (res.status === 401) throw new GmailAuthError();
			if (res.status === 429) throw new GmailRateLimitError();
			throw new GmailError(`Get profile failed with status ${res.status}`);
		}

		const data = (await res.json()) as {
			emailAddress: string;
			messagesTotal?: number;
			historyId?: string;
		};

		return {
			emailAddress: data.emailAddress,
			messagesTotal: data.messagesTotal,
			historyId: data.historyId,
		};
	}

	async listMessages(params: {
		accessToken: string;
		q?: string;
		labelIds?: string[];
		maxResults?: number;
		pageToken?: string;
	}): Promise<{
		messages: GmailMessageSummary[];
		nextPageToken?: string;
		resultSizeEstimate?: number;
	}> {
		const url = new URL("/gmail/v1/users/me/messages", this.baseUrl);
		if (params.q) url.searchParams.set("q", params.q);
		if (params.maxResults)
			url.searchParams.set("maxResults", String(params.maxResults));
		if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);
		if (params.labelIds?.length) {
			for (const labelId of params.labelIds) {
				url.searchParams.append("labelIds", labelId);
			}
		}

		const res = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${params.accessToken}`,
			},
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			if (res.status === 401) throw new GmailAuthError();
			if (res.status === 429) throw new GmailRateLimitError();
			throw new GmailError(`List messages failed with status ${res.status}`);
		}

		const data = (await res.json()) as {
			messages?: Array<{ id: string; threadId?: string }>;
			nextPageToken?: string;
			resultSizeEstimate?: number;
		};

		return {
			messages: data.messages ?? [],
			nextPageToken: data.nextPageToken,
			resultSizeEstimate: data.resultSizeEstimate,
		};
	}

	async listHistory(params: {
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
	}> {
		const url = new URL("/gmail/v1/users/me/history", this.baseUrl);
		url.searchParams.set("startHistoryId", params.startHistoryId);
		if (params.maxResults)
			url.searchParams.set("maxResults", String(params.maxResults));
		if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);

		const res = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${params.accessToken}`,
			},
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (res.status === 404) {
			throw new GmailHistoryExpiredError();
		}

		if (!res.ok) {
			if (res.status === 401) throw new GmailAuthError();
			if (res.status === 429) throw new GmailRateLimitError();
			throw new GmailError(`List history failed with status ${res.status}`);
		}

		const data = (await res.json()) as {
			history?: Array<{
				messagesAdded?: Array<{ message: { id: string } }>;
			}>;
			historyId?: string;
			nextPageToken?: string;
		};

		return {
			history: data.history,
			historyId: data.historyId,
			nextPageToken: data.nextPageToken,
		};
	}

	async getMessageRaw(params: {
		accessToken: string;
		messageId: string;
	}): Promise<GmailRawMessage> {
		const url = new URL(
			`/gmail/v1/users/me/messages/${encodeURIComponent(params.messageId)}`,
			this.baseUrl,
		);
		url.searchParams.set("format", "raw");

		const res = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${params.accessToken}`,
			},
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!res.ok) {
			if (res.status === 401) throw new GmailAuthError();
			if (res.status === 429) throw new GmailRateLimitError();
			throw new GmailError(`Get message failed with status ${res.status}`);
		}

		const data = (await res.json()) as {
			id: string;
			raw: string;
			historyId?: string;
			internalDate?: string;
		};

		return {
			id: data.id,
			raw: data.raw,
			historyId: data.historyId,
			internalDate: data.internalDate,
		};
	}
}

export class MemoryGmailClient implements GmailClient {
	public profile: GmailProfile = {
		emailAddress: "investigator@example.com",
		messagesTotal: 10,
		historyId: "1000",
	};

	public messages: Map<string, GmailRawMessage> = new Map();
	public historyRecords: Array<{
		historyId: string;
		messagesAdded: Array<{ message: { id: string } }>;
	}> = [];

	public simulateAuthError = false;
	public simulateRateLimitCount = 0;
	public simulateHistoryExpired = false;
	public mockRefreshToken = "mock_refresh_token_valid_123456";
	public mockAccessToken = "mock_access_token_valid_123456";

	addRawMessage(message: {
		id: string;
		raw: string | Buffer;
		historyId?: string;
	}): void {
		const rawBase64Url = Buffer.isBuffer(message.raw)
			? message.raw.toString("base64url")
			: Buffer.from(message.raw, "utf8").toString("base64url");

		this.messages.set(message.id, {
			id: message.id,
			raw: rawBase64Url,
			historyId: message.historyId ?? "1001",
		});
	}

	async exchangeCode(_params: {
		code: string;
		codeVerifier: string;
		redirectUri: string;
	}): Promise<GmailTokenResponse> {
		if (this.simulateAuthError) {
			throw new GmailAuthError("Simulated token exchange failure");
		}
		return {
			accessToken: this.mockAccessToken,
			refreshToken: this.mockRefreshToken,
			expiresIn: 3600,
			scope: "https://www.googleapis.com/auth/gmail.readonly",
			tokenType: "Bearer",
		};
	}

	async refreshAccessToken(_params: {
		refreshToken: string;
	}): Promise<{ accessToken: string; expiresIn?: number }> {
		if (this.simulateAuthError) {
			throw new GmailAuthError("Simulated token refresh failure");
		}
		return {
			accessToken: this.mockAccessToken,
			expiresIn: 3600,
		};
	}

	async getProfile(_params: { accessToken: string }): Promise<GmailProfile> {
		if (this.simulateAuthError) throw new GmailAuthError();
		return { ...this.profile };
	}

	async listMessages(params: {
		accessToken: string;
		q?: string;
		labelIds?: string[];
		maxResults?: number;
		pageToken?: string;
	}): Promise<{
		messages: GmailMessageSummary[];
		nextPageToken?: string;
		resultSizeEstimate?: number;
	}> {
		if (this.simulateAuthError) throw new GmailAuthError();
		if (this.simulateRateLimitCount > 0) {
			this.simulateRateLimitCount--;
			throw new GmailRateLimitError("Simulated rate limit exceeded", 50);
		}

		const all = Array.from(this.messages.values()).map((m) => ({ id: m.id }));
		const limit = params.maxResults ?? 200;
		const sliced = all.slice(0, limit);

		return {
			messages: sliced,
			resultSizeEstimate: all.length,
		};
	}

	async listHistory(params: {
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
	}> {
		if (this.simulateAuthError) throw new GmailAuthError();
		if (this.simulateHistoryExpired) throw new GmailHistoryExpiredError();
		if (this.simulateRateLimitCount > 0) {
			this.simulateRateLimitCount--;
			throw new GmailRateLimitError("Simulated rate limit exceeded", 50);
		}

		if (this.historyRecords.length > 0) {
			const startIdNum = Number(params.startHistoryId) || 0;
			const matching = this.historyRecords.filter(
				(h) => (Number(h.historyId) || 0) > startIdNum,
			);
			return {
				history: matching,
				historyId: matching.at(-1)?.historyId ?? params.startHistoryId,
			};
		}

		return {
			history: [],
			historyId: params.startHistoryId,
		};
	}

	async getMessageRaw(params: {
		accessToken: string;
		messageId: string;
	}): Promise<GmailRawMessage> {
		if (this.simulateAuthError) throw new GmailAuthError();
		if (this.simulateRateLimitCount > 0) {
			this.simulateRateLimitCount--;
			throw new GmailRateLimitError("Simulated rate limit exceeded", 50);
		}

		const msg = this.messages.get(params.messageId);
		if (!msg) {
			throw new GmailError(`Message ${params.messageId} not found`);
		}
		return { ...msg };
	}

	clear(): void {
		this.messages.clear();
		this.historyRecords = [];
		this.simulateAuthError = false;
		this.simulateRateLimitCount = 0;
		this.simulateHistoryExpired = false;
	}
}

export const defaultGmailClient: GmailClient =
	env.WEB_DATA_MODE === "live"
		? new HttpGmailClient()
		: new MemoryGmailClient();
