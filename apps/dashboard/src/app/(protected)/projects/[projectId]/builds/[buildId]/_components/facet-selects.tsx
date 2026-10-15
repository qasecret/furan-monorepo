"use client";

import { Divider, Segment } from "./contextual-toolbar";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StepFacets } from "@/lib/review-context";
import { trpc } from "@/lib/trpc";

const DIMENSIONS = [
  { key: "browser", label: "Browser", any: "Any browser" },
  { key: "viewport", label: "Viewport", any: "Any viewport" },
  { key: "os", label: "OS", any: "Any OS" },
  { key: "device", label: "Device", any: "Any device" },
] as const;

/**
 * The value of the "Any ‹dimension›" item. A Radix Select item cannot have an
 * empty value, so "Any" has a sentinel that no environment reports.
 */
const ANY = "__any__";

interface Props {
  buildId: string;
  /** The facets in the URL. */
  facets: StepFacets;
  /** The facets with one set or cleared; the page writes them to the URL. */
  onChange: (next: StepFacets) => void;
}

/**
 * The batch page's environment filter (spec §5.3): one compact select for each
 * of browser, viewport, OS and device that the batch has values for, filled
 * from `runs.facets`. An option reads "‹value› · ‹n› pending" (the pending
 * steps with it, in the whole batch), and "Any ‹dimension›" clears the facet.
 *
 * The selection is the URL's, and a shared link can name a value the batch
 * does not have (or no longer has). Such a value is not dropped: the select
 * shows it as "‹value› (not in this batch)", so the empty list below it has a
 * visible cause and a way out. A dimension the batch has no values for is
 * shown only when the URL names one.
 */
export function FacetSelects({ buildId, facets, onChange }: Props) {
  const query = trpc.runs.facets.useQuery({ buildId });
  const known = query.data;

  const shown = DIMENSIONS.filter(
    ({ key }) => (known?.[key].length ?? 0) > 0 || facets[key] !== undefined,
  );
  if (shown.length === 0) return null;

  const choose = (key: (typeof DIMENSIONS)[number]["key"], value: string) => {
    // Radix reports "" while its items register; that is not a choice.
    if (value === "") return;
    const next: StepFacets = { ...facets };
    if (value === ANY) delete next[key];
    else next[key] = value;
    onChange(next);
  };

  return (
    <>
      <Divider />
      <div
        role="group"
        aria-label="Environment filters"
        className="flex flex-wrap items-end gap-4"
      >
        {shown.map(({ key, label, any }) => {
          const values = known?.[key] ?? [];
          const active = facets[key];
          // Missing only once the batch's values are known: until then a
          // chosen value is taken as it is.
          const missing =
            known !== undefined &&
            active !== undefined &&
            !values.some((v) => v.value === active);
          const text =
            active === undefined
              ? any
              : missing
                ? `${active} (not in this batch)`
                : active;
          return (
            <Segment key={key} label={label}>
              <Select
                value={active ?? ANY}
                onValueChange={(value) => choose(key, value)}
              >
                <SelectTrigger
                  aria-label={`${label}: ${text}`}
                  data-testid={`facet-select-${key}`}
                  className="h-7 w-auto min-w-[8rem] gap-2 px-2 text-xs"
                >
                  {/* The value alone: the option's pending count is for the list. */}
                  <SelectValue>{text}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ANY}>{any}</SelectItem>
                  {values.map((v) => (
                    <SelectItem key={v.value} value={v.value}>
                      {`${v.value} · ${v.pending} pending`}
                    </SelectItem>
                  ))}
                  {missing && (
                    <SelectItem value={active}>
                      {`${active} (not in this batch)`}
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Segment>
          );
        })}
      </div>
    </>
  );
}
