"use client";

import { Sparkles } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";

export function EmptyState() {
  const router = useRouter();
  const params = useSearchParams();
  const hasFilters = params.toString().length > 0;
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <Sparkles className="mb-3 h-8 w-8 text-brand" aria-hidden />
      <p className="text-base font-medium text-zinc-950 dark:text-white">
        All clear
      </p>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {hasFilters
          ? "No open runs match these filters."
          : "No open runs in any of your projects."}
      </p>
      {hasFilters && (
        <Button
          variant="ghost"
          className="mt-4"
          onClick={() => router.replace("/inbox")}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
