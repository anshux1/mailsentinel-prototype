import "server-only";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
	requestId?: string;
	organizationId?: string | null;
	userId?: string | null;
	[key: string]: unknown;
}

const FORBIDDEN_KEY_PARTS = [
	"token",
	"secret",
	"password",
	"auth",
	"cookie",
	"credential",
	"body",
	"content",
	"attachment",
	"raw",
	"key",
	"stack",
] as const;

function isKeySafe(key: string): boolean {
	const lower = key.toLowerCase();
	return !FORBIDDEN_KEY_PARTS.some((forbidden) => lower.includes(forbidden));
}

function sanitizeValue(value: unknown, depth = 0): unknown {
	if (depth > 3) return "[Truncated]";
	if (value === null || value === undefined) return value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Error) {
		return {
			errorClass: value.constructor.name,
			errorName: value.name,
		};
	}
	if (typeof value === "string") {
		return value.length > 500 ? `${value.slice(0, 500)}...` : value;
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((v) => sanitizeValue(v, depth + 1));
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			if (isKeySafe(k)) {
				result[k] = sanitizeValue(v, depth + 1);
			} else {
				result[k] = "[REDACTED]";
			}
		}
		return result;
	}
	return String(value).slice(0, 200);
}

export function formatLogEntry(
	level: LogLevel,
	event: string,
	context: LogContext = {},
): string {
	const payload: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
		event,
	};

	if (context.requestId) payload.requestId = context.requestId;
	if (context.organizationId) payload.organizationId = context.organizationId;
	if (context.userId) payload.userId = context.userId;

	for (const [k, v] of Object.entries(context)) {
		if (k === "requestId" || k === "organizationId" || k === "userId") continue;
		if (isKeySafe(k)) {
			payload[k] = sanitizeValue(v);
		} else {
			payload[k] = "[REDACTED]";
		}
	}

	return JSON.stringify(payload);
}

export const logger = {
	debug(event: string, context?: LogContext): void {
		console.debug(formatLogEntry("debug", event, context));
	},
	info(event: string, context?: LogContext): void {
		console.info(formatLogEntry("info", event, context));
	},
	warn(event: string, context?: LogContext): void {
		console.warn(formatLogEntry("warn", event, context));
	},
	error(event: string, context?: LogContext): void {
		console.error(formatLogEntry("error", event, context));
	},
	withContext(baseContext: LogContext) {
		return {
			debug: (event: string, ctx?: LogContext) =>
				logger.debug(event, { ...baseContext, ...ctx }),
			info: (event: string, ctx?: LogContext) =>
				logger.info(event, { ...baseContext, ...ctx }),
			warn: (event: string, ctx?: LogContext) =>
				logger.warn(event, { ...baseContext, ...ctx }),
			error: (event: string, ctx?: LogContext) =>
				logger.error(event, { ...baseContext, ...ctx }),
		};
	},
};
