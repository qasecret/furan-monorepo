import { test } from "@furan/playwright";

// The square's colour is the "change" between runs; the clock changes every
// run and is ignored by locator.
const color = process.env.FIXTURE_COLOR ?? "#1e40ff";

const html = (title: string): string => `
<body style="margin:0">
  <div style="position:relative;width:400px;height:300px;background:#ffffff">
    <div style="position:absolute;left:50px;top:50px;width:100px;height:100px;background:${color}"></div>
    <span class="clock" style="position:absolute;left:250px;top:10px;font:14px monospace">${new Date().toISOString()}</span>
    <div style="position:absolute;left:200px;top:200px;width:120px;height:40px;background:#222222" title="${title}"></div>
  </div>
</body>`;

test.describe.configure({ mode: "parallel" });

test("home", async ({ page, furan }) => {
  await page.setContent(html("home"));
  await furan.check("home", { ignore: [page.locator(".clock")] });
});

test("cart", async ({ page, furan }) => {
  await page.setContent(html("cart"));
  await furan.check("cart", { ignore: [page.locator(".clock")] });
});
