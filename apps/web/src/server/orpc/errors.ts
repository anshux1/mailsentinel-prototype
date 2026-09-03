import "server-only";

import {
	ConflictError as DbConflictError,
	DependencyError as DbDependencyError,
	NotFoundError as DbNotFoundError,
	RepositoryError as DbRepositoryError,
} from "@mailsentinel/db";
import { ORPCError } from "@orpc/server";
import { logger } from "@/server/logger";

export class AppError extends Error {
	readonly code: string;
	readonly status: number;
	readonly details?: Record<string, unknown>;

	constructor(
		message: string,
		code = "APP_ERROR",
		status = 500,
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = code;
		this.status = status;
		this.details = details;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class UnauthorizedError extends AppError {
	constructor(
		message = "Authentication required",
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, "UNAUTHORIZED", 401, details, options);
	}
}

export class ForbiddenError extends AppError {
	constructor(
		message = "Forbidden: insufficient permissions",
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, "FORBIDDEN", 403, details, options);
	}
}

export class NotFoundError extends AppError {
	constructor(
		message = "Resource not found",
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, "NOT_FOUND", 404, details, options);
	}
}

export class ConflictError extends AppError {
	constructor(
		message = "Conflict with existing resource",
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, "CONFLICT", 409, details, options);
	}
}

export class PayloadTooLargeError extends AppError {
	constructor(
		message = "Payload too large",
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, "PAYLOAD_TOO_LARGE", 413, details, options);
	}
}

export class DependencyError extends AppError {
	readonly dependency?: string;

	constructor(
		message = "Upstream dependency failed or invalid",
		dependency?: string,
		details?: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, "DEPENDENCY_ERROR", 502, details, options);
		this.dependency = dependency;
	}
}

export interface SafeErrorMetadata {
	requestId: string;
	code: string;
	[key: string]: unknown;
}

export function toSafeORPCError(
	error: unknown,
	requestId: string,
): ORPCError<string, unknown> {
	if (error instanceof ORPCError) {
		const existingData =
			error.data && typeof error.data === "object" ? error.data : {};
		const safeData: SafeErrorMetadata = {
			...(existingData as Record<string, unknown>),
			requestId,
			code: (existingData as { code?: string }).code ?? error.code,
		};
		return new ORPCError(error.code, {
			message: error.message,
			status: error.status,
			data: safeData,
			cause: error,
		});
	}

	if (
		error instanceof DbNotFoundError ||
		error instanceof NotFoundError ||
		(error instanceof Error && error.name === "NotFoundError")
	) {
		return new ORPCError("NOT_FOUND", {
			status: 404,
			message: "Resource not found",
			data: { requestId, code: "NOT_FOUND" },
			cause: error,
		});
	}

	if (
		error instanceof DbConflictError ||
		error instanceof ConflictError ||
		(error instanceof Error && error.name === "ConflictError")
	) {
		return new ORPCError("CONFLICT", {
			status: 409,
			message:
				"Resource already exists or operation conflicts with current state",
			data: { requestId, code: "CONFLICT" },
			cause: error,
		});
	}

	if (
		error instanceof DbDependencyError ||
		error instanceof DependencyError ||
		(error instanceof Error && error.name === "DependencyError")
	) {
		return new ORPCError("BAD_GATEWAY", {
			status: 502,
			message:
				"A required upstream dependency or referenced entity is invalid or unavailable",
			data: { requestId, code: "DEPENDENCY_ERROR" },
			cause: error,
		});
	}

	if (
		error instanceof PayloadTooLargeError ||
		(error instanceof Error && error.name === "PayloadTooLargeError")
	) {
		return new ORPCError("PAYLOAD_TOO_LARGE", {
			status: 413,
			message: error.message || "Payload too large",
			data: { requestId, code: "PAYLOAD_TOO_LARGE" },
			cause: error,
		});
	}

	if (
		error instanceof UnauthorizedError ||
		(error instanceof Error && error.name === "UnauthorizedError")
	) {
		return new ORPCError("UNAUTHORIZED", {
			status: 401,
			message: error.message || "Authentication required",
			data: { requestId, code: "UNAUTHORIZED" },
			cause: error,
		});
	}

	if (
		error instanceof ForbiddenError ||
		(error instanceof Error && error.name === "ForbiddenError")
	) {
		return new ORPCError("FORBIDDEN", {
			status: 403,
			message: error.message || "Forbidden: insufficient permissions",
			data: { requestId, code: "FORBIDDEN" },
			cause: error,
		});
	}

	if (error instanceof DbRepositoryError) {
		const errorClass = error.constructor.name || "RepositoryError";
		const errorName = error.name || "RepositoryError";
		logger.error("Repository error intercepted", {
			requestId,
			code: error.code,
			errorClass,
			errorName,
		});
		return new ORPCError("INTERNAL_SERVER_ERROR", {
			status: 500,
			message: "An internal database error occurred",
			data: { requestId, code: "REPOSITORY_ERROR" },
			cause: error,
		});
	}

	// Unexpected / unhandled errors: log only safe error class/name and stable code/context;
	// never log arbitrary exception messages or stacks as they may contain evidence or secrets.
	const errorClass =
		error instanceof Error
			? error.constructor.name || error.name || "Error"
			: typeof error;
	const errorName =
		error instanceof Error
			? error.name || error.constructor.name
			: "UnknownError";

	logger.error("Unhandled exception during oRPC procedure execution", {
		requestId,
		code: "INTERNAL_SERVER_ERROR",
		errorClass,
		errorName,
	});

	return new ORPCError("INTERNAL_SERVER_ERROR", {
		status: 500,
		message: "An unexpected error occurred",
		data: { requestId, code: "INTERNAL_SERVER_ERROR" },
		cause: error,
	});
}
