import "@tanstack/react-query";

declare module "@tanstack/react-query" {
	interface Register {
		/** `silent` opts a mutation out of the global error toast. */
		mutationMeta: {
			silent?: boolean;
		};
	}
}
