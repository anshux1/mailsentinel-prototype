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

test("offers a secure demo sign-in form", async ({ page }) => {
	await page.goto("/sign-in");
	await expect(
		page.getByRole("heading", { name: "Investigator sign in" }),
	).toBeVisible();
	await expect(page.getByLabel("Email")).toHaveValue("demo@mailsentinel.local");
});
