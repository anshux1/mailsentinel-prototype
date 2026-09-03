import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const inter = Inter({
	variable: "--font-inter",
	subsets: ["latin"],
	display: "swap",
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
	display: "swap",
});

export const metadata: Metadata = {
	title: {
		default: "MailSentinel — Explainable email forensics",
		template: "%s · MailSentinel",
	},
	description:
		"A tenant-scoped workspace for investigating suspicious email: private evidence, deterministic analysis, and immutable forensic reports.",
};

export const viewport: Viewport = {
	themeColor: "#07080a",
	colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html
			lang="en"
			// Dark is the only mode in this system; the class pins shadcn's
			// `dark:` variants on regardless of the OS preference.
			className={`dark ${inter.variable} ${geistMono.variable} h-full antialiased`}
			suppressHydrationWarning
		>
			<body className="flex min-h-full flex-col bg-canvas text-body">
				<Providers>{children}</Providers>
			</body>
		</html>
	);
}
