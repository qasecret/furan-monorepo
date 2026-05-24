import type { Metadata } from "next";
import { use } from "react";

import { VariationHistory } from "./_components/variation-history";

export const metadata: Metadata = { title: "Variation history" };

export default function Page({
  params,
}: {
  params: Promise<{ projectId: string; variationId: string }>;
}) {
  const { projectId, variationId } = use(params);
  return <VariationHistory projectId={projectId} variationId={variationId} />;
}
