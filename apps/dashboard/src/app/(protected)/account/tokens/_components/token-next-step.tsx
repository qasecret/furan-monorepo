import { DocsLink } from "@/components/docs-link";

/** After a token is created: where it goes, and the next step (A6). */
export function TokenNextStep() {
  return (
    <p className="text-sm text-fg-secondary" data-testid="token-next-step">
      Add it to your CI secrets as{" "}
      <code className="font-mono text-xs text-fg">FURAN_API_TOKEN</code>. Next:{" "}
      <DocsLink slug="getting-started/first-upload">
        Send your first screenshots
      </DocsLink>
    </p>
  );
}
