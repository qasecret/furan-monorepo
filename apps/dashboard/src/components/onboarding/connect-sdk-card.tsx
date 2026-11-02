"use client";

import Link from "next/link";
import { Fragment } from "react";

import { DocsLink } from "@/components/docs-link";
import { CopyField } from "@/components/ui/copy-field";
import { useViewerRole } from "@/lib/commands/registry";
import { isAtLeastAdmin } from "@/lib/roles";
import { useApiUrl } from "@/lib/use-api-url";

/**
 * Where a role creates an API token: admins (and owners) on Admin → API
 * Tokens, editors on their own page; anyone else can't create one.
 */
export function tokenPageFor(role: string): string | null {
  if (isAtLeastAdmin(role)) return "/admin/api-keys";
  if (role === "editor") return "/account/tokens";
  return null;
}

const DRIVERS = [
  ["Selenium", "selenium"],
  ["Playwright", "playwright"],
  ["Appium", "appium"],
  ["REST", "rest"],
] as const;

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="font-mono text-2xs text-fg-muted">{name}</p>
      {children}
    </div>
  );
}

/**
 * The three values an SDK needs, ready to copy, on a project's first-run empty
 * states (first-run spec §3.5): the API URL as an SDK must be given it, the
 * project ID, and where to create a token. Each driver's link opens that
 * driver's tab of the upload guide, which carries the dependency coordinates.
 */
export function ConnectSdkCard({ projectId }: { projectId: string }) {
  const apiUrl = useApiUrl();
  const tokenPage = tokenPageFor(useViewerRole());
  return (
    <div
      className="w-full max-w-md space-y-3 text-left"
      data-testid="connect-sdk-card"
    >
      <div>
        <p className="text-sm font-medium text-fg">Connect the SDK</p>
        <p className="text-xs text-fg-secondary">
          Set these three values where your tests run.
        </p>
      </div>
      <Row name="FURAN_API_URL">
        {apiUrl ? (
          <CopyField
            value={apiUrl}
            label="API URL"
            data-testid="connect-api-url"
          />
        ) : (
          <div
            className="h-7 animate-pulse rounded-md bg-sunken"
            data-testid="api-url-pending"
          />
        )}
        <p className="text-2xs text-fg-muted">
          If your CI reaches Furan by another address, use that one.
        </p>
      </Row>
      <Row name="FURAN_PROJECT_ID">
        <CopyField
          value={projectId}
          label="project ID"
          data-testid="connect-project-id"
        />
      </Row>
      <Row name="FURAN_API_TOKEN">
        {tokenPage ? (
          <Link
            href={tokenPage}
            className="text-sm text-brand-text hover:underline focus-ring"
          >
            Create an API token →
          </Link>
        ) : (
          <p className="text-sm text-fg-secondary">
            Ask an admin for an API token.
          </p>
        )}
      </Row>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 border-t border-edge pt-3 text-xs">
        {DRIVERS.map(([name, driver], i) => (
          <Fragment key={driver}>
            {i > 0 && (
              <span aria-hidden className="text-fg-muted">
                ·
              </span>
            )}
            <DocsLink slug="getting-started/first-upload" query={{ driver }}>
              {name}
            </DocsLink>
          </Fragment>
        ))}
      </div>
      <DocsLink
        slug="getting-started/first-upload"
        className="text-xs text-brand-text hover:underline focus-ring"
      >
        Full guide
      </DocsLink>
    </div>
  );
}
