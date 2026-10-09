import { Reveal } from "./reveal";

/* Honest capability highlights — not fabricated vanity metrics. */
const ITEMS = [
  { value: "3-tier", label: "Pixel · VLM · a11y diffing" },
  { value: "100%", label: "Self-hosted on your infra" },
  { value: "3 SDKs", label: "Selenium · Playwright · Appium" },
  { value: "Docker", label: "One-command deployment" },
];

export function LandingCapabilities() {
  return (
    <section className="py-20">
      <Reveal className="mx-auto max-w-6xl px-4">
        <div className="grid grid-cols-2 gap-y-10 divide-edge md:grid-cols-4 md:divide-x">
          {ITEMS.map((item) => (
            <div key={item.label} className="px-4 text-center">
              <div className="text-4xl font-bold tracking-tight text-brand-text md:text-5xl">
                {item.value}
              </div>
              <div className="mt-2 text-sm font-medium text-fg-secondary">
                {item.label}
              </div>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
