export type DateLike = Date | string | number | null | undefined;

function toDate(value: DateLike): Date | null {
	if (value === null || value === undefined) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: DateLike, fallback = "—"): string {
	const date = toDate(value);
	if (!date) return fallback;
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

export function formatDate(value: DateLike, fallback = "—"): string {
	const date = toDate(value);
	if (!date) return fallback;
	return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
		date,
	);
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["year", 31_536_000_000],
	["month", 2_592_000_000],
	["week", 604_800_000],
	["day", 86_400_000],
	["hour", 3_600_000],
	["minute", 60_000],
	["second", 1000],
];

export function formatRelativeTime(value: DateLike, now = Date.now()): string {
	const date = toDate(value);
	if (!date) return "—";
	const delta = date.getTime() - now;
	const absolute = Math.abs(delta);
	if (absolute < 45_000) return "just now";

	const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, ms] of RELATIVE_UNITS) {
		if (absolute >= ms || unit === "second") {
			return formatter.format(Math.round(delta / ms), unit);
		}
	}
	return "just now";
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
	if (bytes < 1024) return `${bytes} B`;
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${BYTE_UNITS[unit]}`;
}

/** Digests are long and opaque; show enough to compare by eye. */
export function truncateDigest(digest: string, head = 10, tail = 6): string {
	if (digest.length <= head + tail + 1) return digest;
	return `${digest.slice(0, head)}…${digest.slice(-tail)}`;
}

export function formatPercent(value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return "—";
	return `${Math.round(value * 100)}%`;
}

export function titleCase(value: string): string {
	return value
		.replace(/[_.-]+/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());
}

export function pluralize(count: number, singular: string, plural?: string) {
	return count === 1 ? singular : (plural ?? `${singular}s`);
}
