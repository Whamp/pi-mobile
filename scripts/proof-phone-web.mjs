import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const output = process.env.P2W_PHONE_WEB_PROOF ?? "/workspace/badlogic-torture/proof/web/emulator-backend";
const session = process.argv[2];
if (session) assert(/^[a-f0-9-]+$/.test(session));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox"] });
try {
	const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
	const page = await context.newPage();
	page.setDefaultTimeout(600000);
	await page.goto(`http://127.0.0.1:18787/${session ? `s/${session}` : ""}`, { timeout: 600000 });
	const skip = page.getByRole("button", { name: "Skip for now" });
	if (!session) {
		await page.getByRole("dialog", { name: "Welcome to p2w" }).waitFor();
		for (const [name, width, height] of [
			["folded", 412, 915],
			["unfolded", 840, 900],
		]) {
			await page.setViewportSize({ width, height });
			await page.screenshot({ path: join(output, `${name}-onboarding.png`) });
		}
		await skip.click();
		assert.match(await page.locator(".composer .chip").innerText(), /GPT-6\.1 Sol[\s\S]*high/);
		await page.locator(".composer .chip").click();
		await page.getByRole("dialog", { name: "Model", exact: true }).waitFor();
		assert.equal(await page.locator(".model-row").count(), 5);
		await writeFile(join(output, "models.txt"), await page.locator(".model-list").innerText());
		for (const [name, width, height] of [
			["folded", 412, 915],
			["unfolded", 840, 900],
		]) {
			await page.setViewportSize({ width, height });
			await page.screenshot({ path: join(output, `${name}-models.png`) });
		}
	} else {
		if (await skip.isVisible()) await skip.click();
		await page.locator(".nested-call.error").waitFor();
		for (const [name, width, height] of [
			["folded", 412, 915],
			["unfolded", 840, 900],
		]) {
			await page.setViewportSize({ width, height });
			await page.locator(".nested-call.error").scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `${name}-interrupted-3.png`) });
			const code = page.locator(".tool-head").filter({ hasText: "Code" });
			if ((await code.getAttribute("aria-expanded")) !== "true") await code.click();
			await page.locator(".nested-call.error").scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `${name}-final-result.png`) });
			await writeFile(join(output, `${name}-final.txt`), await page.locator(".tool").innerText());
		}
	}
	await writeFile(
		join(output, "source.json"),
		JSON.stringify(
			{
				at: new Date().toISOString(),
				origin: "http://127.0.0.1:18787",
				backend: "APK Node on emulator-5572 via same-port adb forward",
				renderer: "host Chrome fallback",
				session,
			},
			null,
			2,
		),
	);
	console.log("Captured phone-backend web proof");
} finally {
	await browser.close();
}
