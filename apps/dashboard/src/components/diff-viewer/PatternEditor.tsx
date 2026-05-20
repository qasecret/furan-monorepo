"use client";

import {
  REGION_PATTERN_LABELS,
  REGION_PATTERN_PRESETS,
  type RegionPatternPresetKey,
} from "@furan/shared-types";
import { useMemo } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  value: string;
  onChange: (pattern: string) => void;
}

const PRESET_KEYS = Object.keys(
  REGION_PATTERN_PRESETS,
) as RegionPatternPresetKey[];

/**
 * Preset dropdown + custom regex input for dynamic-text regions. The
 * caller sees only the resolved regex string via `onChange`. "Custom…"
 * unlocks the inline text input. When `value` exactly matches a preset
 * source string the dropdown reflects that preset name; otherwise the
 * dropdown sits on "Custom…" and the input is shown.
 */
export function PatternEditor({ value, onChange }: Props) {
  const matchingPreset = useMemo<RegionPatternPresetKey | "custom">(() => {
    for (const key of PRESET_KEYS) {
      if (REGION_PATTERN_PRESETS[key] === value) return key;
    }
    return "custom";
  }, [value]);

  return (
    <div className="flex items-center gap-2" data-testid="pattern-editor">
      <Select
        value={matchingPreset}
        onValueChange={(v) => {
          if (v === "custom") return;
          onChange(REGION_PATTERN_PRESETS[v as RegionPatternPresetKey]);
        }}
      >
        <SelectTrigger
          className="w-36 text-xs"
          data-testid="pattern-preset-trigger"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PRESET_KEYS.map((k) => (
            <SelectItem key={k} value={k}>
              {REGION_PATTERN_LABELS[k]}
            </SelectItem>
          ))}
          <SelectItem value="custom">Custom…</SelectItem>
        </SelectContent>
      </Select>
      {matchingPreset === "custom" && (
        <Input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="regex"
          className="w-48 text-xs font-mono"
          data-testid="pattern-custom-input"
        />
      )}
    </div>
  );
}
