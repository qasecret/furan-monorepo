"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useMemo } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { trpc } from "@/lib/trpc";

/**
 * Per-engine knob definitions — drives the structured "Engine knobs"
 * sub-form. Mirrors the predecessor frontend's modal which exposed every
 * algorithm-specific option (threshold, antialiasing, layout-fail, etc.)
 * so reviewers didn't have to hand-edit JSON. Furan stores the raw
 * config blob in `projects.imageComparisonConfig`; this editor reads +
 * writes that string while the textarea below remains as an escape hatch
 * for fields the structured form doesn't know about.
 *
 * Defaults match the engine packages' actual defaults so a freshly-
 * selected engine renders something sensible.
 */
const ENGINE_KNOBS: Record<
  "pixelmatch" | "looks_same" | "odiff",
  ReadonlyArray<
    | {
        kind: "number";
        key: string;
        label: string;
        min: number;
        max: number;
        step: number;
        default: number;
        help: string;
      }
    | {
        kind: "boolean";
        key: string;
        label: string;
        default: boolean;
        help: string;
      }
  >
> = {
  pixelmatch: [
    {
      kind: "number",
      key: "threshold",
      label: "Threshold",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      help: "Pixel matching threshold (0 = exact; 1 = anything).",
    },
    {
      kind: "boolean",
      key: "ignoreAntialiasing",
      label: "Ignore antialiasing",
      default: true,
      help: "Skip anti-aliased pixels in the diff.",
    },
    {
      kind: "boolean",
      key: "allowDiffDimensions",
      label: "Allow diff dimensions",
      default: false,
      help: "Don't fail when baseline and candidate have different dimensions.",
    },
  ],
  looks_same: [
    {
      kind: "boolean",
      key: "strict",
      label: "Strict",
      default: false,
      help: "Pixel-perfect comparison; disables tolerance.",
    },
    {
      kind: "number",
      key: "tolerance",
      label: "Tolerance",
      min: 0,
      max: 50,
      step: 0.1,
      default: 2.3,
      help: "Perceptual tolerance in CIEDE2000 units (default ~2.3 matches the library default).",
    },
    {
      kind: "number",
      key: "antialiasingTolerance",
      label: "Antialiasing tolerance",
      min: 0,
      max: 50,
      step: 0.1,
      default: 0,
      help: "Extra tolerance applied within detected antialiased regions.",
    },
    {
      kind: "boolean",
      key: "ignoreAntialiasing",
      label: "Ignore antialiasing",
      default: true,
      help: "Skip anti-aliased pixels in the diff.",
    },
    {
      kind: "boolean",
      key: "ignoreCaret",
      label: "Ignore caret",
      default: true,
      help: "Skip the blinking text-cursor diff (useful for text fields).",
    },
    {
      kind: "boolean",
      key: "allowDiffDimensions",
      label: "Allow diff dimensions",
      default: false,
      help: "Don't fail when baseline and candidate have different dimensions.",
    },
  ],
  // Odiff knobs map onto the shared EngineConfig (packages/diff-engine
  // /src/types.ts): {threshold, ignoreAntialiasing, allowDiffDimensions}.
  // Earlier revisions of this form wrote `antialiasing`, `failOnLayoutDiff`,
  // and `outputDiffMask` — keys the engine never read. The toggles
  // looked like they were doing something but had no effect on diff
  // output, and the structured form rendered "Antialiasing detection"
  // as OFF for projects whose saved JSON had `ignoreAntialiasing:true`.
  // Align the odiff section with the keys the engine actually consumes.
  odiff: [
    {
      kind: "number",
      key: "threshold",
      label: "Threshold",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.1,
      help: "Pixel matching threshold (0 = exact; 1 = anything).",
    },
    {
      kind: "boolean",
      key: "ignoreAntialiasing",
      label: "Ignore antialiasing",
      default: true,
      help: "Skip anti-aliased pixels in the diff (more lenient, slightly slower).",
    },
    {
      kind: "boolean",
      key: "allowDiffDimensions",
      label: "Allow diff dimensions",
      default: false,
      help: "Don't fail when baseline and candidate have different dimensions.",
    },
  ],
};

/**
 * Zod schema mirrors `projects.update`'s server schema, with two tweaks
 * for the React Hook Form ↔ <input type="number"> reality:
 *
 *  - integer fields use `z.coerce.number()` because controlled number
 *    inputs surface their value as a string. We keep the raw string in
 *    form state (so the input stays controlled even mid-edit) and
 *    coerce at parse time.
 *  - `imageComparisonConfig` is treated as a JSON string. Empty is
 *    allowed (lets users clear the override) and otherwise the value
 *    must parse. Structured editing lands in v1.1+.
 */
const schema = z.object({
  name: z.string().min(1, "Required").max(120),
  mainBranchName: z.string().min(1, "Required").max(120),
  diffThreshold: z.number().min(0).max(1),
  dynamicTextEnabled: z.boolean(),
  autoApproveFeature: z.boolean(),
  imageComparison: z.enum(["pixelmatch", "looks_same", "odiff", "vlm"]),
  retentionDays: z.coerce.number().int().min(1).max(3650),
  maxBuildAllowed: z.coerce.number().int().min(1),
  maxBranchLifetime: z.coerce.number().int().min(1),
  imageComparisonConfig: z.string().refine((s) => {
    if (s.trim() === "") return true;
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  }, "Must be valid JSON or empty"),
});

type FormValues = z.infer<typeof schema>;

/**
 * Structured per-engine config editor. Reads the current
 * `imageComparisonConfig` JSON string, parses it, and renders a control
 * per `ENGINE_KNOBS[engine]` entry. Changes flow back to the form by
 * re-serializing the merged object — fields the editor doesn't know
 * about are preserved verbatim, so users with custom keys (set via the
 * JSON textarea or future engines) don't lose them on save.
 *
 * Parse failures fall back to `{}` (empty object) silently — the JSON
 * textarea below shows the raw value and its own validation message, so
 * the structured editor stays usable while the user fixes the JSON.
 */
const VLM_DEFAULTS = {
  provider: "ollama" as const,
  model: "gemma3:12b",
  prompt: "",
  temperature: 0.1,
  apiKey: "",
};

type VlmConfig = {
  provider: "ollama" | "gemini" | "anthropic";
  model: string;
  prompt: string;
  temperature: number;
  apiKey: string;
};

function EngineKnobsEditor({
  engine,
  form,
  disabled,
}: {
  engine: "pixelmatch" | "looks_same" | "odiff" | "vlm";
  form: UseFormReturn<FormValues>;
  disabled: boolean;
}) {
  const rawConfig = form.watch("imageComparisonConfig");
  const parsed = useMemo<Record<string, unknown>>(() => {
    if (!rawConfig || rawConfig.trim() === "") return {};
    try {
      const obj = JSON.parse(rawConfig);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }, [rawConfig]);

  // Radix UI Select v2 fires `onValueChange("")` from its hidden form-control
  // `<select>` when the controlled value changes before SelectItems have
  // registered (SelectContent renders into a DocumentFragment set via a
  // layout effect, so on the first sync after `form.reset` the native
  // `<select>` has zero `<option>`s and silently falls back to ""). The
  // imageComparison Select below filters that empty string out, but guard
  // here too so a future regression can't crash render.

  const writeKey = (key: string, value: unknown): void => {
    const next: Record<string, unknown> = { ...parsed, [key]: value };
    form.setValue("imageComparisonConfig", JSON.stringify(next, null, 2), {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  if (engine === "vlm") {
    const vlm: VlmConfig = {
      ...VLM_DEFAULTS,
      ...(typeof parsed.provider === "string" &&
      ["ollama", "gemini", "anthropic"].includes(parsed.provider)
        ? { provider: parsed.provider as VlmConfig["provider"] }
        : {}),
      ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
      ...(typeof parsed.prompt === "string" ? { prompt: parsed.prompt } : {}),
      ...(typeof parsed.temperature === "number"
        ? { temperature: parsed.temperature }
        : {}),
      ...(typeof parsed.apiKey === "string" ? { apiKey: parsed.apiKey } : {}),
    };

    return (
      <div
        className="space-y-3 rounded-md border border-zinc-200 bg-zinc-100/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
        data-testid="engine-knobs-vlm"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          VLM knobs
        </p>

        <div className="space-y-1">
          <Label htmlFor="vlm-provider">Provider</Label>
          <Select
            value={vlm.provider}
            onValueChange={(v) => {
              if (v) writeKey("provider", v);
            }}
            disabled={disabled}
          >
            <SelectTrigger id="vlm-provider" data-testid="vlm-provider-select">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ollama">Ollama (local)</SelectItem>
              <SelectItem value="gemini">Google Gemini</SelectItem>
              <SelectItem value="anthropic">Anthropic Claude</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            VLM provider. Ollama runs locally; Gemini and Anthropic require an
            API key.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="vlm-model">Model name</Label>
          <Input
            id="vlm-model"
            value={vlm.model}
            onChange={(e) => writeKey("model", e.target.value)}
            disabled={disabled}
            data-testid="vlm-model-input"
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Model identifier (e.g. gemma3:12b for Ollama, gemini-2.0-flash for
            Gemini).
          </p>
        </div>

        {(vlm.provider === "gemini" || vlm.provider === "anthropic") && (
          <div className="space-y-1">
            <Label htmlFor="vlm-api-key">API Key</Label>
            <Input
              id="vlm-api-key"
              type="password"
              value={vlm.apiKey}
              onChange={(e) => writeKey("apiKey", e.target.value)}
              disabled={disabled}
              placeholder="Enter API key…"
              data-testid="vlm-api-key-input"
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              API key for the selected provider. Stored in the project config
              JSON.
            </p>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="vlm-temperature">
            Temperature ({vlm.temperature})
          </Label>
          <Slider
            id="vlm-temperature"
            value={[vlm.temperature]}
            onValueChange={([v]: number[]) => writeKey("temperature", v ?? 0.1)}
            min={0}
            max={1}
            step={0.05}
            disabled={disabled}
            data-testid="vlm-temperature-slider"
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Controls randomness in the VLM response. Lower values produce more
            deterministic output.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="vlm-prompt">Custom prompt</Label>
          <textarea
            id="vlm-prompt"
            rows={6}
            value={vlm.prompt}
            onChange={(e) => writeKey("prompt", e.target.value)}
            disabled={disabled}
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-mono text-zinc-950 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-zinc-300 focus-visible:ring-1 focus-visible:ring-brand dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:placeholder:text-zinc-400 dark:focus-visible:border-zinc-700"
            placeholder="Override the default VLM system prompt…"
            data-testid="vlm-prompt-textarea"
          />
          <p className="text-xs text-zinc-500 dark:text-zinc-500">
            Optional. Replaces the default system prompt sent to the VLM. Leave
            blank to use the built-in prompt.
          </p>
        </div>
      </div>
    );
  }

  const knobs = ENGINE_KNOBS[engine];
  if (!knobs) return null;

  return (
    <div
      className="space-y-3 rounded-md border border-zinc-200 bg-zinc-100/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40"
      data-testid={`engine-knobs-${engine}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
        {engine} knobs
      </p>
      {knobs.map((knob) => {
        if (knob.kind === "boolean") {
          const value =
            typeof parsed[knob.key] === "boolean"
              ? (parsed[knob.key] as boolean)
              : knob.default;
          return (
            <div
              key={knob.key}
              className="flex items-start justify-between gap-4"
            >
              <div>
                <label
                  htmlFor={`engine-${engine}-${knob.key}`}
                  className="text-sm font-medium text-zinc-800 dark:text-zinc-200"
                >
                  {knob.label}
                </label>
                <p className="text-xs text-zinc-500 dark:text-zinc-500">
                  {knob.help}
                </p>
              </div>
              <Switch
                id={`engine-${engine}-${knob.key}`}
                checked={value}
                onCheckedChange={(v) => writeKey(knob.key, v)}
                disabled={disabled}
                data-testid={`engine-${engine}-${knob.key}`}
              />
            </div>
          );
        }
        const value =
          typeof parsed[knob.key] === "number"
            ? (parsed[knob.key] as number)
            : knob.default;
        return (
          <div key={knob.key} className="space-y-1">
            <label
              htmlFor={`engine-${engine}-${knob.key}`}
              className="block text-sm font-medium text-zinc-800 dark:text-zinc-200"
            >
              {knob.label} ({value})
            </label>
            <Input
              id={`engine-${engine}-${knob.key}`}
              type="number"
              min={knob.min}
              max={knob.max}
              step={knob.step}
              value={value}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) writeKey(knob.key, n);
              }}
              disabled={disabled}
              data-testid={`engine-${engine}-${knob.key}`}
            />
            <p className="text-xs text-zinc-500 dark:text-zinc-500">
              {knob.help}
            </p>
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  projectId: string;
  userRole: "admin" | "editor" | "guest";
}

export function ProjectSettingsForm({ projectId, userRole }: Props) {
  const utils = trpc.useUtils();
  const {
    data: project,
    isLoading,
    error,
  } = trpc.projects.getById.useQuery({ projectId });

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      mainBranchName: "main",
      diffThreshold: 0.001,
      dynamicTextEnabled: false,
      autoApproveFeature: false,
      imageComparison: "odiff",
      retentionDays: 90,
      maxBuildAllowed: 100,
      maxBranchLifetime: 30,
      imageComparisonConfig: "",
    },
  });

  // Populate form when project data lands. `form.reset` here is
  // intentional: it both fills defaults and clears the dirty state so
  // navigating back to the page after a save shows a clean form.
  useEffect(() => {
    if (project) {
      form.reset({
        name: project.name ?? "",
        mainBranchName: project.mainBranchName ?? "main",
        diffThreshold: project.diffThreshold ?? 0.001,
        dynamicTextEnabled: project.dynamicTextEnabled ?? false,
        autoApproveFeature: project.autoApproveFeature ?? false,
        imageComparison: project.imageComparison ?? "odiff",
        retentionDays: project.retentionDays ?? 90,
        maxBuildAllowed: project.maxBuildAllowed ?? 100,
        maxBranchLifetime: project.maxBranchLifetime ?? 30,
        imageComparisonConfig: project.imageComparisonConfig ?? "",
      });
    }
  }, [project, form]);

  const update = trpc.projects.update.useMutation({
    onSuccess: async () => {
      form.reset(form.getValues());
      await utils.projects.getById.invalidate({ projectId });
      toast.success("Settings saved");
    },
    onError: (e: { message: string }) => {
      toast.error(e.message || "Failed to save settings");
    },
  });

  const isGuest = userRole === "guest";

  if (isLoading) {
    return (
      <div className="text-sm text-zinc-600 dark:text-zinc-400">
        Loading settings…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-red-400">Error: {error.message}</div>;
  }
  if (!project) {
    return (
      <div className="text-sm text-zinc-600 dark:text-zinc-400">
        No project data.
      </div>
    );
  }

  const onSubmit = (values: FormValues): void => {
    update.mutate({ projectId, ...values });
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-6"
        data-testid="project-settings-form"
      >
        <Card>
          <CardHeader>
            <CardTitle>Basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Project name</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="name-input" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="mainBranchName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Main branch</FormLabel>
                  <FormControl>
                    <Input {...field} data-testid="main-branch-input" />
                  </FormControl>
                  <FormDescription>
                    The default branch used as the baseline fallback (e.g.{" "}
                    <code>main</code> or <code>master</code>).
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Diff behavior</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="diffThreshold"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Diff threshold: {(field.value * 100).toFixed(2)}%
                  </FormLabel>
                  <FormControl>
                    <Slider
                      value={[field.value * 100]}
                      onValueChange={([v]: number[]) =>
                        field.onChange((v ?? 0) / 100)
                      }
                      min={0}
                      max={100}
                      step={0.05}
                      data-testid="diff-threshold-slider"
                    />
                  </FormControl>
                  <FormDescription>
                    Pixel-diff above this triggers DOM-level analysis. Default
                    0.10%.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="dynamicTextEnabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4">
                  <div>
                    <FormLabel>Dynamic text regions</FormLabel>
                    <FormDescription>
                      Enable regex-anchored ignore regions. For each region
                      tagged &quot;dynamic text&quot;, Furan runs OCR on the
                      candidate screenshot and masks the region only when the
                      extracted text matches the pattern. Adds ~200ms–2s per
                      diff for projects with dynamic-text regions.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="dynamic-text-enabled-switch"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="autoApproveFeature"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4">
                  <div>
                    <FormLabel>Auto-approve feature branches</FormLabel>
                    <FormDescription>
                      Mark feature-branch runs as approved automatically (use
                      with caution).
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="auto-approve-switch"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Image comparison</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="imageComparison"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Algorithm</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      if (v) field.onChange(v);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="image-comparison-select">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="odiff">Odiff (default)</SelectItem>
                      <SelectItem value="pixelmatch">Pixelmatch</SelectItem>
                      <SelectItem value="looks_same">Looks-Same</SelectItem>
                      <SelectItem value="vlm">VLM (AI Vision)</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Pixel comparison backend. Odiff is the default; Pixelmatch
                    matches the jest-image-snapshot / Percy world; Looks-Same is
                    perceptual and antialiasing-tolerant; VLM uses an AI vision
                    model for semantic diff analysis.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <EngineKnobsEditor
              engine={form.watch("imageComparison")}
              form={form}
              disabled={isGuest}
            />
            <FormField
              control={form.control}
              name="imageComparisonConfig"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Algorithm config (JSON — advanced)</FormLabel>
                  <FormControl>
                    <textarea
                      {...field}
                      rows={4}
                      className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-mono text-zinc-950 placeholder:text-zinc-400 focus-visible:outline-none focus-visible:border-zinc-300 focus-visible:ring-1 focus-visible:ring-brand dark:border-zinc-800 dark:bg-zinc-900 dark:text-white dark:placeholder:text-zinc-400 dark:focus-visible:border-zinc-700"
                      data-testid="image-config-textarea"
                    />
                  </FormControl>
                  <FormDescription>
                    The structured editor above writes here. Edit directly to
                    set custom keys the structured form doesn't expose, or leave
                    blank for engine defaults.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Limits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="maxBuildAllowed"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max builds retained</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value as unknown as string}
                      onChange={(e) => field.onChange(e.target.value)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      data-testid="max-build-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="maxBranchLifetime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Max branch lifetime (days)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value as unknown as string}
                      onChange={(e) => field.onChange(e.target.value)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      data-testid="max-branch-input"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Retention</CardTitle>
          </CardHeader>
          <CardContent>
            <FormField
              control={form.control}
              name="retentionDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Retention (days)</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      value={field.value as unknown as string}
                      onChange={(e) => field.onChange(e.target.value)}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                      data-testid="retention-input"
                    />
                  </FormControl>
                  <FormDescription>
                    Old runs are deleted after this many days. Enforced nightly
                    by the diff-worker retention job.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="sticky bottom-4 flex items-center justify-end gap-3 z-10">
          {form.formState.isDirty && !update.isPending && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Unsaved changes
            </span>
          )}
          <Button
            type="submit"
            disabled={isGuest || update.isPending}
            title={isGuest ? "Guests can't modify project settings" : undefined}
            data-testid="save-button"
            variant={form.formState.isDirty ? "default" : "secondary"}
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
