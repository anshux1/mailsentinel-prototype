"use client";

import { motion, type Variants } from "motion/react";
import type * as React from "react";

import { fadeUp, listItem, stagger } from "@/lib/motion";
import { cn } from "@/lib/utils";

type DivProps = React.ComponentProps<"div">;

/** Single element entering on mount. */
export function FadeUp({
	className,
	delay = 0,
	children,
	...props
}: DivProps & { delay?: number }) {
	return (
		<motion.div
			initial="hidden"
			animate="visible"
			variants={fadeUp}
			transition={{ delay }}
			className={cn(className)}
			{...(props as React.ComponentProps<typeof motion.div>)}
		>
			{children}
		</motion.div>
	);
}

/** Parent that staggers its `<StaggerItem>` children in. */
export function Stagger({
	className,
	gap = 0.045,
	delay = 0,
	children,
	...props
}: DivProps & { gap?: number; delay?: number }) {
	return (
		<motion.div
			initial="hidden"
			animate="visible"
			variants={stagger(gap, delay) as Variants}
			className={cn(className)}
			{...(props as React.ComponentProps<typeof motion.div>)}
		>
			{children}
		</motion.div>
	);
}

export function StaggerItem({ className, children, ...props }: DivProps) {
	return (
		<motion.div
			variants={listItem}
			className={cn(className)}
			{...(props as React.ComponentProps<typeof motion.div>)}
		>
			{children}
		</motion.div>
	);
}

/** Reveals a block when it scrolls into view — used on the marketing page. */
export function RevealOnScroll({
	className,
	amount = 0.25,
	children,
	...props
}: DivProps & { amount?: number }) {
	return (
		<motion.div
			initial="hidden"
			whileInView="visible"
			viewport={{ once: true, amount }}
			variants={fadeUp}
			className={cn(className)}
			{...(props as React.ComponentProps<typeof motion.div>)}
		>
			{children}
		</motion.div>
	);
}
