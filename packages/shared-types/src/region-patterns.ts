/**
 * Built-in regex patterns for dynamic-text regions. Display-name → regex
 * source string. The wire shape is always the regex string — these are a
 * UI convenience, not a separate field. Users can pick "Custom..." to type
 * their own regex.
 *
 * Patterns are deliberately permissive enough to handle OCR jitter (e.g.
 * the date pattern accepts common US, EU, and ISO forms). They use
 * `String.raw` so the regex source is readable.
 */
export const REGION_PATTERN_PRESETS = {
  date: String.raw`\b(\d{1,2}[\s\-\/]+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s\-\/]+\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*[\s\-\/]+\d{1,2},?\s+\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b`,
  email: String.raw`[\w.+-]+@[\w-]+\.[\w.-]+`,
  url: String.raw`https?:\/\/[^\s]+`,
  phone: String.raw`(?:\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3,4}[\s-]?\d{4}`,
  ssn: String.raw`\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b`,
} as const;

export type RegionPatternPresetKey = keyof typeof REGION_PATTERN_PRESETS;

/** Human-readable labels rendered in the Pattern dropdown. */
export const REGION_PATTERN_LABELS: Record<RegionPatternPresetKey, string> = {
  date: "Date",
  email: "Email address",
  url: "URL",
  phone: "Phone number",
  ssn: "Social Security number",
};
