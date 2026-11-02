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

// An element shot of a footer far below the fold, with a clock inside it:
// its ignore region must land on the clock although the screenshot scrolls.
const footerPage = (): string => `
<body style="margin:0">
  <div style="height:1500px;background:#ffffff"></div>
  <div class="footer" style="position:relative;width:400px;height:120px;background:${color}">
    <span class="clock" style="position:absolute;left:10px;top:10px;font:14px monospace;color:#ffffff">${new Date().toISOString()}</span>
  </div>
</body>`;

test("footer", async ({ page, furan }) => {
  await page.setContent(footerPage());
  const footer = page.locator(".footer");
  await furan.check("footer", {
    locator: footer,
    ignore: [footer.locator(".clock")],
  });
});
