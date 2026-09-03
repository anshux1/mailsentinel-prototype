export class RepositoryError extends Error {
	readonly code: string;

	constructor(message: string, code = "REPOSITORY_ERROR", options?: ErrorOptions) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class NotFoundError extends RepositoryError {
	readonly entity: string;
	readonly identifier: string;
	readonly organizationId?: string;

	constructor(entity: string, identifier: string, organizationId?: string, message?: string, options?: ErrorOptions) {
		const defaultMessage = `${entity} '${identifier}' not found${
			organizationId ? ` in organization '${organizationId}'` : ""
		}`;
		super(message ?? defaultMessage, "NOT_FOUND", options);
		this.entity = entity;
		this.identifier = identifier;
		this.organizationId = organizationId;
	}
}

export class ConflictError extends RepositoryError {
	readonly details?: Record<string, unknown>;

	constructor(message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
		super(message, "CONFLICT", options);
		this.details = details;
	}
}

export class InvalidStateError extends RepositoryError {
	readonly currentStatus?: string;
	readonly targetStatus?: string;

	constructor(message: string, currentStatus?: string, targetStatus?: string, options?: ErrorOptions) {
		super(message, "INVALID_STATE", options);
		this.currentStatus = currentStatus;
		this.targetStatus = targetStatus;
	}
}

export class DependencyError extends RepositoryError {
	readonly dependency?: string;

	constructor(message: string, dependency?: string, options?: ErrorOptions) {
		super(message, "DEPENDENCY_ERROR", options);
		this.dependency = dependency;
	}
}

export function assertOrganizationId(organizationId: unknown): asserts organizationId is string {
	if (typeof organizationId !== "string" || organizationId.trim().length === 0) {
		throw new RepositoryError("organizationId is mandatory and cannot be empty", "INVALID_TENANT_CONTEXT");
	}
}

export function isDatabaseError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	let current: unknown = error;
	while (current && typeof current === "object") {
		const obj = current as {
			name?: string;
			code?: string;
			severity?: string;
			severity_local?: string;
			routine?: string;
			query?: unknown;
			cause?: unknown;
		};
		if (
			obj.name === "PostgresError" ||
			obj.name === "DrizzleQueryError" ||
			obj.severity !== undefined ||
			obj.severity_local !== undefined ||
			obj.routine !== undefined ||
			obj.query !== undefined
		) {
			return true;
		}
		if (typeof obj.code === "string" && /^[0-9A-Z]{5}$/.test(obj.code)) {
			return true;
		}
		current = obj.cause;
	}
	return false;
}

export function mapDatabaseError(error: unknown, context?: string): never {
	if (error instanceof RepositoryError) {
		throw error;
	}

	// Unwrap DrizzleQueryError or similar driver wrappers to inspect PostgreSQL error code
	let current: unknown = error;
	let code: string | undefined;

	while (current && typeof current === "object") {
		const obj = current as {
			code?: string;
			cause?: unknown;
		};

		if (typeof obj.code === "string") {
			code = obj.code;
			break;
		}

		current = obj.cause;
	}

	if (code === "23505") {
		throw new ConflictError("A resource with the specified identifier or unique field already exists", undefined, {
			cause: error,
		});
	}

	if (code === "23503") {
		throw new DependencyError("Referenced resource or dependent entity does not exist", undefined, { cause: error });
	}

	if (code === "23514") {
		throw new InvalidStateError("Operation violates database integrity constraint", undefined, undefined, {
			cause: error,
		});
	}

	if (code === "23502") {
		throw new InvalidStateError("Required field missing in database operation", undefined, undefined, { cause: error });
	}

	const genericMessage = context ? `Database operation failed during ${context}` : "Database operation failed";
	throw new RepositoryError(genericMessage, "DATABASE_ERROR", {
		cause: error,
	});
}
