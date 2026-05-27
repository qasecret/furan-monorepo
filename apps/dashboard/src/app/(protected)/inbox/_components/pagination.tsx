"use client";

import { Button } from "@/components/ui/button";

interface Props {
  hasMore: boolean;
  onNext: () => void;
}

export function Pagination({ hasMore, onNext }: Props) {
  if (!hasMore) return null;
  return (
    <div className="border-t border-zinc-900 px-4 py-3">
      <Button variant="ghost" onClick={onNext}>
        Load more
      </Button>
    </div>
  );
}
