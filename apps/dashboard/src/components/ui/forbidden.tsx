import type { ReactNode } from "react";

import { Card } from "./card";

/**
 * Standard 403 card body — a consistent forbidden surface for admin/role
 * gates. Callers wrap it in their own `<PageContainer>` for layout.
 */
export function Forbidden({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}) {
  return (
    <Card>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
      <p className="text-sm text-fg-secondary">{description}</p>
    </Card>
  );
}
