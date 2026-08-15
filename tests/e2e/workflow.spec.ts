import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Handle the phone through one calm text thread." })).toBeVisible();
  await page.getByRole("button", { name: "Continue locally" }).click();
  await expect(page.getByRole("heading", { name: "Your Liaison thread" })).toBeVisible();
}

async function sendMessage(page: Page, text: string, withKeyboard = false): Promise<void> {
  const composer = page.getByLabel("Message Liaison");
  await composer.fill(text);
  if (withKeyboard) await composer.press("Control+Enter");
  else await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("list", { name: "Message history" }).getByText(text, { exact: true })).toBeVisible();
}

test("complete keyboard-operable supervised simulation", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Advanced cases" }).click();
  await expect(page.getByRole("heading", { name: "A calm, readable way to handle the phone." })).toBeVisible();
  await expect(page.getByText("Real calls off")).toBeVisible();
  await page.getByRole("button", { name: "Create a support case" }).click();
  await page.getByLabel("Your first name").fill("Avery");
  await page.getByLabel("Company name").fill("Northstar Goods");
  await page.getByLabel("Official US support number").fill("(212) 555-0198");
  await page
    .getByLabel("Describe the issue")
    .fill("A newly delivered item arrived defective and customer support needs to correct the order.");
  await page.getByLabel("Relevant chronology").fill("Item arrived defective yesterday");
  await page.getByLabel("Desired resolution").fill("Replace the defective item at no charge");
  await page.getByLabel("Acceptable alternatives").fill("Refund the item");
  await page.getByLabel("Unacceptable outcomes").fill("Pay a new fee");
  await page.getByLabel("Facts the assistant may use").fill("The item was defective on arrival");
  await page.getByLabel(/I obtained this number/).check();
  await page.getByLabel(/I am calling about my own account/).check();
  await page.getByLabel(/This is not emergency/).check();
  await page.getByRole("button", { name: "Create editable plan" }).click();
  await expect(page.getByRole("heading", { name: "Northstar Goods support request" })).toBeVisible();
  await page.getByLabel("Plan title").fill("Defective item replacement");
  await page.getByLabel("Simulation scenario").selectOption("cancellation-offer");
  await expect(page.getByRole("button", { name: /place real call/i })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve and run developer scenario" }).click();
  await expect(page.getByRole("heading", { name: "Call in progress" })).toBeVisible();
  await page.getByRole("button", { name: "Pause agent" }).click();
  await expect(page.getByText("Paused — transcript still active").first()).toBeVisible();
  await page.getByLabel("Say this exactly").fill("Please continue when ready.");
  await page.getByRole("button", { name: "Speak exact text" }).click();
  await page.getByRole("button", { name: "Resume agent" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeFocused();
  await expect(dialog.getByText("Liaison will not continue until you choose.")).toBeVisible();
  const cockpitApprove = dialog.getByRole("button", { name: "Approve" });
  await expect(cockpitApprove).toBeDisabled();
  await dialog.getByRole("checkbox", { name: /I understand this is a material decision/ }).check();
  await expect(cockpitApprove).toBeEnabled();
  await cockpitApprove.click();
  await expect(page.getByRole("heading", { name: "Call complete" })).toBeVisible();
  await expect(page.getByText("A concrete outcome was confirmed.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Export text" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toBeVisible();
});

test("complete primary messaging workflow with low-risk and secure decisions", async ({ page }) => {
  await signIn(page);

  const importantUpdate = page.getByRole("status").filter({ hasText: "Latest important update" });
  await expect(importantUpdate).toHaveAttribute("aria-live", "polite");
  await expect(importantUpdate).toHaveAttribute("aria-atomic", "true");

  const issue =
    "Company: Northstar Cable\nCall Northstar Cable at (212) 555-0198. They charged a $35 installation fee to my account. I want them to remove the fee and credit $35. Do not change my plan.";
  await sendMessage(page, issue, true);
  const history = page.getByRole("list", { name: "Message history" });
  await expect(history.getByText(/Is this your account, or one you are authorized to manage/)).toBeVisible();
  await sendMessage(page, "YES");
  await expect(history.getByText(/PLAN 1 - REVIEW REQUIRED/)).toBeVisible();
  await expect(history.getByText(/Reply APPROVE PLAN to create a one-time call code/)).toBeVisible();
  await expect(page.locator(".thread-status").getByText("Awaiting plan approval", { exact: true })).toBeVisible();
  const secureDisclosures = page.locator(".secure-disclosures");
  await secureDisclosures.getByRole("button", { name: "Add an allowed detail" }).click();
  await secureDisclosures.getByLabel("Sensitive value").fill("772299");
  await secureDisclosures.getByRole("button", { name: "Save allowed detail" }).click();
  await expect(secureDisclosures.getByText("Account number", { exact: true })).toBeVisible();
  await expect(page.getByText("772299", { exact: true })).toHaveCount(0);

  await sendMessage(page, "APPROVE PLAN");
  const authorizationMessage = history
    .locator(".thread-message")
    .filter({ hasText: /reply exactly CALL [A-Z0-9]{4,8}/i })
    .last();
  await expect(authorizationMessage).toBeVisible();
  const authorizationText = await authorizationMessage.innerText();
  const authorization = authorizationText.match(/CALL ([A-Z0-9]{4,8})/);
  expect(authorization, "The approved plan response must expose one exact short-lived call code").not.toBeNull();
  const exactCallCommand = `CALL ${authorization![1]}`;
  await page.getByLabel("Message Liaison").fill(exactCallCommand);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(history.getByText("CALL [CALL_CODE]", { exact: true })).toBeVisible();
  await expect(history.getByText(exactCallCommand, { exact: true })).toHaveCount(0);
  await expect(history.getByText(/Calling Northstar Cable now/)).toBeVisible();

  const lowConsequence = page.locator(".attention-card");
  await expect(lowConsequence.getByText("Continue waiting", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(lowConsequence.getByText("Ask for wait estimate", { exact: true })).toBeVisible();
  await expect(lowConsequence.getByText("Ask for a supervisor", { exact: true })).toBeVisible();
  await lowConsequence.getByRole("button", { name: /Ask for wait estimate/ }).click();
  await expect(history.getByText(/Ask for wait estimate\. The call is continuing/)).toBeVisible();

  const secureReviewLink = page.getByRole("link", { name: "Review securely" });
  await expect(secureReviewLink).toBeVisible({ timeout: 15_000 });
  const href = await secureReviewLink.getAttribute("href");
  expect(href).toMatch(/^\/a\/[A-Za-z0-9_-]{20,200}$/);
  expect(new URL(href!, page.url()).origin).toBe(new URL(page.url()).origin);
  await secureReviewLink.focus();
  await expect(secureReviewLink).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/a\/[A-Za-z0-9_-]{20,200}$/);
  const secureReview = page
    .locator(".secure-review")
    .filter({ has: page.getByRole("heading", { name: "Review this request" }) });
  await expect(secureReview).toBeVisible();
  await expect(secureReview.getByRole("definition").filter({ hasText: /confirm the billing ZIP/i })).toBeVisible();
  await expect(secureReview.getByText("Representative request", { exact: true })).toBeVisible();
  await expect(secureReview.getByText("Current approved goal", { exact: true })).toBeVisible();
  await expect(secureReview.getByText("Consequence", { exact: true })).toBeVisible();
  await expect(secureReview.getByRole("heading", { name: "Current authority" })).toBeVisible();
  await expect(secureReview.getByText("Personal-data disclosure", { exact: true })).toBeVisible();
  await expect(secureReview.getByRole("heading", { name: "Recent transcript context" })).toBeVisible();
  await expect(secureReview.getByText(/Stored transcript text is redacted/)).toBeVisible();
  await secureReview.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(secureReview.getByText("This request was rejected.", { exact: true })).toBeVisible();

  const materialAttention = page.locator(".attention-card.tier-material");
  await expect(materialAttention).toBeVisible({ timeout: 15_000 });
  await expect(materialAttention.getByText(/accept the representative's retention offer/i)).toBeVisible();
  const materialReviewLink = materialAttention.getByRole("link", { name: "Review securely" });
  const materialHref = await materialReviewLink.getAttribute("href");
  expect(materialHref).toMatch(/^\/a\/[A-Za-z0-9_-]{20,200}$/);
  expect(materialHref).not.toBe(href);
  await materialReviewLink.click();

  await expect(page).toHaveURL(new RegExp(`${materialHref!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(secureReview.getByText("Material", { exact: true })).toBeVisible();
  await expect(secureReview.getByRole("alert").filter({ hasText: /Approval is blocked by a condition/ })).toBeVisible();
  await expect(secureReview.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await secureReview.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(secureReview.getByText("This request was rejected.", { exact: true })).toBeVisible();

  await expect(history.getByText("CALL COMPLETE", { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(history.getByText(/Verified commitments:.*\$35 account credit/i)).toBeVisible();
  await expect(page.locator(".thread-status").getByText("Completed", { exact: true })).toBeVisible();
  const commitments = page
    .locator(".message-side-panel")
    .filter({ has: page.getByRole("heading", { name: "Commitments" }) });
  await expect(commitments.locator("strong").filter({ hasText: /full \$35 account credit/i })).toBeVisible();
  await commitments.getByText(/Grounding evidence \(1\)/).click();
  await expect(
    commitments.locator("blockquote").filter({ hasText: /I approved a full \$35 account credit/i }),
  ).toBeVisible();
  await expect(commitments.getByText(/Transcript turn/)).toBeVisible();

  const outcomeLink = history.getByRole("link", { name: "Open call outcome in Liaison" });
  await expect(outcomeLink).toBeVisible();
  const outcomeHref = await outcomeLink.getAttribute("href");
  expect(outcomeHref).toMatch(/^\/calls\/[0-9a-f-]{36}$/i);
  await outcomeLink.click();
  await expect(page).toHaveURL(new RegExp(`${outcomeHref!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("heading", { name: "Call complete" })).toBeVisible();
  await expect(page.getByText("A concrete outcome was confirmed.")).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Handle the phone through one calm text thread." })).toBeVisible();
  await page.getByRole("button", { name: "Continue locally" }).click();
  await expect(page).toHaveURL(new RegExp(`${outcomeHref!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  await expect(page.getByRole("heading", { name: "Call complete" })).toBeVisible();
  await expect(page.getByText("A concrete outcome was confirmed.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Call complete" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Your Liaison thread" })).toBeVisible();

  await page.getByRole("button", { name: "Delete case data" }).click();
  const deleteGroup = page.getByRole("group", { name: "Permanently delete this case?" });
  const deleteButton = deleteGroup.getByRole("button", { name: "Delete permanently" });
  await expect(deleteButton).toBeDisabled();
  await deleteGroup.getByLabel(/Type DELETE/).fill("DELETE");
  await deleteGroup.getByRole("checkbox", { name: /cannot be recovered/ }).check();
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(page.getByText("The case and its stored conversation data were deleted.")).toBeVisible();
  await expect(page.getByText("Describe the company and problem in the thread.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Message history" })).toHaveCount(0);
});
