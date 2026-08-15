import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { buildApp } from "../src/server/app.js";

/**
 * Captures the frames used for the README demo animation.
 *
 * Drives the real application in mock/simulator mode — no provider credentials, no telephone call —
 * and writes numbered PNGs to `.demo-frames/`. Encode them with the ffmpeg command printed at the
 * end. Kept in the repository so the animation can be regenerated after a UI change rather than
 * becoming a stale screenshot nobody can reproduce.
 *
 *   npx tsx scripts/capture-demo.ts
 */

const OUTPUT = path.resolve(".demo-frames");
const PORT = 3210;
const VIEWPORT = { width: 1280, height: 820 };

let frame = 0;

/**
 * The thread auto-scrolls its inner message list, and `scrollIntoView` on a nested scroller also
 * moves the window. Left alone that drifts the page mid-capture and leaves half the frame empty,
 * so every capture pins the window back to the top first; the inner list keeps its own position.
 */
async function capture(page: Page, label: string, focus?: string): Promise<void> {
  if (focus) {
    await page.locator(focus).first().scrollIntoViewIfNeeded();
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(250);
  frame += 1;
  const file = path.join(OUTPUT, `${String(frame).padStart(2, "0")}-${label}.png`);
  await page.screenshot({ path: file });
  process.stdout.write(`  frame ${String(frame).padStart(2, "0")}  ${label}\n`);
}

/** Screenshots are stills, so each step needs a beat for animations and polling to settle. */
async function settle(page: Page, ms = 700): Promise<void> {
  await page.waitForTimeout(ms);
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel("Message Liaison").fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

rmSync(OUTPUT, { recursive: true, force: true });
mkdirSync(OUTPUT, { recursive: true });

process.env.NODE_ENV = "test";
process.env.LLM_MODE = "mock";
process.env.TELEPHONY_MODE = "simulator";
process.env.MESSAGING_MODE = "web";
process.env.ALLOW_REAL_CALLS = "false";
process.env.ALLOW_REAL_MESSAGING = "false";
process.env.APP_ACCESS_KEY = "";
process.env.OWNER_DISPLAY_NAME = "Avery";
process.env.SESSION_SECRET = "demo-session-secret-that-is-long-enough";
process.env.CALL_TOKEN_SECRET = "demo-call-secret-that-is-long-enough";
process.env.ACTION_LINK_SECRET = "demo-action-secret-that-is-long-enough";
process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.PUBLIC_WSS_URL = `ws://127.0.0.1:${PORT}`;

const { app } = await buildApp({}, { databasePath: ":memory:" });
await app.listen({ port: PORT, host: "127.0.0.1" });
process.stdout.write(`Serving demo instance on http://127.0.0.1:${PORT}\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });

try {
  // 1 — the pitch
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByRole("heading", { name: "Handle the phone through one calm text thread." }).waitFor();
  await settle(page);
  await capture(page, "sign-in");

  await page.getByRole("button", { name: "Continue locally" }).click();
  await page.getByRole("heading", { name: "Your Liaison thread" }).waitFor();
  await settle(page);
  await capture(page, "empty-thread");

  // 2 — one natural-language message
  const issue =
    "Company: Northstar Cable\nCall Northstar Cable at (212) 555-0198. They charged a $35 installation fee to my account. I want them to remove the fee and credit $35. Do not change my plan.";
  const history = page.getByRole("list", { name: "Message history" });
  await send(page, issue);
  await history.getByText(/Is this your account, or one you are authorized to manage/).waitFor();
  await settle(page);
  await capture(page, "asks-only-what-is-missing");

  // 3 — the inspectable plan
  await send(page, "YES");
  await history.getByText(/PLAN 1 - REVIEW REQUIRED/).waitFor();
  await settle(page);
  await capture(page, "plan-and-authority");

  // 4 — approval mints a one-time code
  await send(page, "APPROVE PLAN");
  const authorization = history
    .locator(".thread-message")
    .filter({ hasText: /reply exactly CALL [A-Z0-9]{4,8}/i })
    .last();
  await authorization.waitFor();
  await settle(page);
  await capture(page, "one-time-call-code");

  // 5 — only the exact code starts the call, and it is never stored
  const code = (await authorization.innerText()).match(/CALL ([A-Z0-9]{4,8})/);
  if (!code) throw new Error("The approved plan did not expose a call code.");
  await send(page, `CALL ${code[1]}`);
  await history.getByText(/Calling Northstar Cable now/).waitFor();
  await settle(page);
  await capture(page, "call-started-code-redacted");

  // 6 — a trivial choice answered in one keystroke
  const lowConsequence = page.locator(".attention-card");
  await lowConsequence.getByText("Ask for wait estimate", { exact: true }).waitFor({ timeout: 20_000 });
  await settle(page);
  await capture(page, "low-consequence-choice");
  await lowConsequence.getByRole("button", { name: /Ask for wait estimate/ }).click();
  await history.getByText(/Ask for wait estimate\. The call is continuing/).waitFor();

  // 7 — a sensitive decision leaves the thread for an authenticated page
  const secureLink = page.getByRole("link", { name: "Review securely" });
  await secureLink.waitFor({ timeout: 20_000 });
  await settle(page);
  await capture(page, "sensitive-needs-secure-review");
  await secureLink.click();
  const secureReview = page
    .locator(".secure-review")
    .filter({ has: page.getByRole("heading", { name: "Review this request" }) });
  await secureReview.waitFor();
  await settle(page);
  await capture(page, "secure-review-with-evidence");
  await secureReview.getByRole("button", { name: "Reject", exact: true }).click();
  await secureReview.getByText("This request was rejected.", { exact: true }).waitFor();

  // 8 — a material offer the approved plan forbids: no approve button exists
  const material = page.locator(".attention-card.tier-material");
  await material.waitFor({ timeout: 20_000 });
  await material.getByRole("link", { name: "Review securely" }).click();
  await secureReview.getByText("Material", { exact: true }).waitFor();
  await settle(page);
  await capture(page, "conditional-rule-blocks-approval");
  await secureReview.getByRole("button", { name: "Reject", exact: true }).click();
  await secureReview.getByText("This request was rejected.", { exact: true }).waitFor();

  // 9 — the outcome, with every claim tied to a transcript quote.
  // Rejecting leaves the browser on the secure-action URL, so return to the thread first.
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByRole("heading", { name: "Your Liaison thread" }).waitFor();
  await history.getByText("CALL COMPLETE", { exact: false }).waitFor({ timeout: 20_000 });
  await settle(page, 1_200);
  await capture(page, "outcome-with-verified-commitment");

  const commitments = page
    .locator(".message-side-panel")
    .filter({ has: page.getByRole("heading", { name: "Commitments" }) });
  await commitments.getByText(/Grounding evidence \(1\)/).click();
  await commitments.locator("blockquote").first().waitFor();
  await settle(page);
  await capture(page, "grounding-evidence", ".message-side-panel:has(h2:text('Commitments'))");

  process.stdout.write(`\nWrote ${frame} frames to ${OUTPUT}\n\nEncode with:\n`);
  process.stdout.write(
    `  ffmpeg -y -framerate 1/2.2 -pattern_type glob -i ".demo-frames/*.png" ` +
      `-vf "scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" ` +
      `-loop 0 docs/media/liaison-demo.gif\n`,
  );
} finally {
  await browser.close();
  await app.close();
}
