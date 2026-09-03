import type { Transition, Variants } from "motion/react";

/**
 * Shared motion vocabulary. Movement is small (4–12px) and fast (0.2–0.45s) so
 * the interface feels responsive rather than animated — DESIGN.md's restraint
 * applied to time instead of colour.
 */
export const brandEase = [0.16, 1, 0.3, 1] as const;

export const transition: Transition = {
	duration: 0.32,
	ease: brandEase,
};

export const quickTransition: Transition = {
	duration: 0.18,
	ease: brandEase,
};

export const fadeUp: Variants = {
	hidden: { opacity: 0, y: 8 },
	visible: { opacity: 1, y: 0, transition },
	exit: { opacity: 0, y: -4, transition: quickTransition },
};

export const fade: Variants = {
	hidden: { opacity: 0 },
	visible: { opacity: 1, transition },
	exit: { opacity: 0, transition: quickTransition },
};

export const scaleIn: Variants = {
	hidden: { opacity: 0, scale: 0.98, y: 6 },
	visible: { opacity: 1, scale: 1, y: 0, transition },
	exit: { opacity: 0, scale: 0.98, y: 4, transition: quickTransition },
};

/** Parent for list/grid entrances — children inherit `fadeUp`. */
export function stagger(staggerChildren = 0.045, delayChildren = 0): Variants {
	return {
		hidden: {},
		visible: { transition: { staggerChildren, delayChildren } },
		exit: {},
	};
}

export const listItem: Variants = {
	hidden: { opacity: 0, y: 6 },
	visible: { opacity: 1, y: 0, transition: quickTransition },
	exit: { opacity: 0, y: -6, transition: quickTransition },
};
