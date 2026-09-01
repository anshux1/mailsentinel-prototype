import { expect, test } from "@playwright/test";

test("renders the MailSentinel foundation and typed health", async ({
	page,
}) => {
	await page.goto("/");
	await expect(
		page.getByRole("heading", { name: "Understand every signal in an email." }),
	).toBeVisible();
	await expect(page.getByText("Operational")).toBeVisible();
});

test("creates and invalidates a demo session", async ({ page }) => {
	await page.goto("/sign-in");
	await expect(
		page.getByRole("heading", { name: "Investigator sign in" }),
	).toBeVisible();
	await expect(page.getByLabel("Email")).toHaveValue("demo@mailsentinel.local");
	await page.getByLabel("Password").fill("MailSentinel-Demo-2026!");
	await page.getByRole("button", { name: "Sign in securely" }).click();
	await page.waitForURL("/");
	await expect(page.getByText("demo@mailsentinel.local")).toBeVisible();
	await page.getByRole("button", { name: "Sign out" }).click();
	await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
});
