import createClient from "openapi-fetch";
import type { paths } from "../generated/analyzer";

export function createAnalyzerClient(input: { baseUrl: string; serviceToken: string }) {
	return createClient<paths>({
		baseUrl: input.baseUrl,
		headers: { Authorization: `Bearer ${input.serviceToken}` },
	});
}
