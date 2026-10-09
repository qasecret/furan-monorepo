"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Clock,
  Gauge,
  GitCompareArrows,
  Layers,
  ScanEye,
  Settings,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm, type FieldErrors, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { MergeBaselinesPanel } from "../../variations/_components/merge-baselines-panel";
import { VariationsList } from "../../variations/_components/variations-list";

import { Button } from "@/components/ui/button";
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
import { isAtLeastAdmin, type ViewerRole } from "@/lib/roles";
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
 *    must be a JSON object (the API rejects anything else — ADR-060).
 *  - `vlmApiKey` / `vlmClearApiKey` are form-only: the Visual-AI key is
 *    write-only (the API never returns it), so a new key or a removal is
 *    held here and folded into the config only at submit time — it never
 *    appears in the JSON textarea.
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
      const parsed: unknown = JSON.parse(s);
      return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }, "Must be a JSON object or empty"),
  vlmApiKey: z.string(),
  vlmClearApiKey: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

/**
 * Section model for the collapsible layout. Each field maps to the section
 * that owns it so a submit-time validation error can force its section open
 * even if the user collapsed it.
 */
type SectionId = "basics" | "diff" | "image" | "limits" | "retention";
type TabId = SectionId | "variations";
const FIELD_SECTION: Record<string, SectionId> = {
  name: "basics",
  mainBranchName: "basics",
  diffThreshold: "diff",
  dynamicTextEnabled: "diff",
  autoApproveFeature: "diff",
  imageComparison: "image",
  imageComparisonConfig: "image",
  vlmApiKey: "image",
  vlmClearApiKey: "image",
  maxBuildAllowed: "limits",
  maxBranchLifetime: "limits",
  retentionDays: "retention",
};

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
};

type VlmConfig = {
  provider: "ollama" | "gemini" | "anthropic";
  model: string;
  prompt: string;
  temperature: number;
};

/**
 * Fold the form-only key fields into the config JSON at submit time
 * (ADR-060). Untouched → config unchanged, so the API keeps the stored key;
 * a new key → `apiKey: <key>`; Remove → `apiKey: ""` (explicit clear).
 */
function withApiKeyChange(
  config: string,
  change: { replaceWith: string; clear: boolean },
): string {
  if (!change.replaceWith && !change.clear) return config;
  const obj: Record<string, unknown> =
    config.trim() === "" ? {} : (JSON.parse(config) as Record<string, unknown>);
  obj.apiKey = change.replaceWith || "";
  return JSON.stringify(obj, null, 2);
}

/** Readable text for API error codes surfaced on save. */
const SAVE_ERRORS: Record<string, string> = {
  vlm_provider_settings_admin_only:
    "Only admins can change the AI provider, its endpoint, or its API key.",
};

function EngineKnobsEditor({
  engine,
  form,
  disabled,
  canEditProvider,
  hasApiKey,
}: {
  engine: "pixelmatch" | "looks_same" | "odiff" | "vlm";
  form: UseFormReturn<FormValues>;
  disabled: boolean;
  /** Admin+ only: provider / baseUrl / API key (ADR-060). */
  canEditProvider: boolean;
  /** Whether the project already has a key stored (the value is never sent). */
  hasApiKey: boolean;
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
    };
    const newApiKey = form.watch("vlmApiKey");
    const clearApiKey = form.watch("vlmClearApiKey");
    const setKeyField = (
      name: "vlmApiKey" | "vlmClearApiKey",
      value: string | boolean,
    ): void => {
      form.setValue(name, value as never, { shouldDirty: true });
    };

    return (
      <div
        className="space-y-3 rounded-md border border-edge bg-sunken p-3"
        data-testid="engine-knobs-vlm"
      >
        <p className="text-xs font-semibold uppercase tracking-wide text-fg-secondary">
          VLM knobs
        </p>

        <div className="space-y-1">
          <Label htmlFor="vlm-provider">Provider</Label>
          <Select
            value={vlm.provider}
            onValueChange={(v) => {
              if (v) writeKey("provider", v);
            }}
            disabled={disabled || !canEditProvider}
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
          <p className="text-xs text-fg-muted">
            VLM provider. Ollama runs locally; Gemini and Anthropic require an
            API key.
          </p>
          {!canEditProvider && (
            <p
              className="text-xs text-fg-secondary"
              data-testid="vlm-provider-admin-only-hint"
            >
              Only admins can change the provider, its endpoint, or its API key
              — they decide where screenshots are sent.
            </p>
          )}
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
          <p className="text-xs text-fg-muted">
            Model identifier (e.g. gemma3:12b for Ollama, gemini-2.0-flash for
            Gemini).
          </p>
        </div>

        {(vlm.provider === "gemini" || vlm.provider === "anthropic") && (
          <div className="space-y-1">
            <Label htmlFor="vlm-api-key">API Key</Label>
            <p
              className="text-xs text-fg-secondary"
              data-testid="vlm-api-key-status"
            >
              {clearApiKey
                ? "The key will be removed when you save."
                : hasApiKey
                  ? "A key is configured. It is never shown again."
                  : "No key configured."}
            </p>
            <div className="flex items-center gap-2">
              <Input
                id="vlm-api-key"
                type="password"
                autoComplete="new-password"
                value={newApiKey}
                onChange={(e) => setKeyField("vlmApiKey", e.target.value)}
                disabled={disabled || !canEditProvider || clearApiKey}
                placeholder={
                  hasApiKey
                    ? "Enter a new key to replace it…"
                    : "Paste the provider API key…"
                }
                data-testid="vlm-api-key-input"
              />
              {canEditProvider &&
                hasApiKey &&
                (clearApiKey ? (
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0 whitespace-nowrap"
                    onClick={() => setKeyField("vlmClearApiKey", false)}
                    data-testid="vlm-api-key-undo-remove"
                  >
                    Undo
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    className="shrink-0 whitespace-nowrap"
                    disabled={disabled}
                    onClick={() => {
                      setKeyField("vlmApiKey", "");
                      setKeyField("vlmClearApiKey", true);
                    }}
                    data-testid="vlm-api-key-remove"
                  >
                    Remove key
                  </Button>
                ))}
            </div>
            <p className="text-xs text-fg-muted">
              Write-only: saved keys are never displayed or sent back to the
              browser. Leave blank to keep the current key.
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
          <p className="text-xs text-fg-muted">
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
            className="w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm font-mono text-fg placeholder:text-fg-muted focus-ring"
            placeholder="Override the default VLM system prompt…"
            data-testid="vlm-prompt-textarea"
          />
          <p className="text-xs text-fg-muted">
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
      className="space-y-3 rounded-md border border-edge bg-sunken p-3"
      data-testid={`engine-knobs-${engine}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-secondary">
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
                  className="text-sm font-medium text-fg"
                >
                  {knob.label}
                </label>
                <p className="text-xs text-fg-muted">{knob.help}</p>
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
              className="block text-sm font-medium text-fg"
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
            <p className="text-xs text-fg-muted">{knob.help}</p>
          </div>
        );
      })}
    </div>
  );
}

const LABEL_CLS =
  "text-xs font-medium uppercase tracking-wider font-mono text-fg-muted";

const TABS: ReadonlyArray<{
  id: TabId;
  label: string;
  icon: typeof Settings;
  desc: string;
}> = [
  {
    id: "basics",
    label: "Basics",
    icon: Settings,
    desc: "Project identity and branch configuration.",
  },
  {
    id: "diff",
    label: "Diff behavior",
    icon: GitCompareArrows,
    desc: "Threshold, dynamic text, and auto-approve settings.",
  },
  {
    id: "image",
    label: "Image comparison",
    icon: ScanEye,
    desc: "Pixel comparison algorithm and engine-specific knobs.",
  },
  {
    id: "limits",
    label: "Limits",
    icon: Gauge,
    desc: "Maximum builds and branch lifetime caps.",
  },
  {
    id: "retention",
    label: "Retention",
    icon: Clock,
    desc: "How long old runs are kept before cleanup.",
  },
  {
    id: "variations",
    label: "Variations",
    icon: Layers,
    desc: "Viewport and browser variations tracked by this project.",
  },
];

interface Props {
  projectId: string;
  userRole: ViewerRole;
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
      vlmApiKey: "",
      vlmClearApiKey: false,
    },
  });

  const [activeTab, setActiveTab] = useState<TabId>("basics");

  const onInvalidSwitchTab = (errors: FieldErrors<FormValues>): void => {
    for (const field of Object.keys(errors)) {
      const sec = FIELD_SECTION[field];
      if (sec) {
        setActiveTab(sec);
        return;
      }
    }
  };

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
        vlmApiKey: "",
        vlmClearApiKey: false,
      });
    }
  }, [project, form]);

  const update = trpc.projects.update.useMutation({
    onSuccess: async () => {
      // Drop the just-saved key from form state; the refetch reports it
      // via hasVlmApiKey.
      form.reset({ ...form.getValues(), vlmApiKey: "", vlmClearApiKey: false });
      await utils.projects.getById.invalidate({ projectId });
      toast.success("Settings saved");
    },
    onError: (e: { message: string }) => {
      toast.error(
        SAVE_ERRORS[e.message] ?? (e.message || "Failed to save settings"),
      );
    },
  });

  const isGuest = userRole === "guest";

  if (isLoading) {
    return <div className="text-sm text-fg-secondary">Loading settings…</div>;
  }
  if (error) {
    return (
      <div className="text-sm text-destructive">Error: {error.message}</div>
    );
  }
  if (!project) {
    return <div className="text-sm text-fg-secondary">No project data.</div>;
  }

  const onSubmit = ({
    vlmApiKey,
    vlmClearApiKey,
    ...values
  }: FormValues): void => {
    update.mutate({
      projectId,
      ...values,
      imageComparisonConfig: withApiKeyChange(values.imageComparisonConfig, {
        replaceWith: vlmApiKey,
        clear: vlmClearApiKey,
      }),
    });
  };

  const activeMeta = TABS.find((t) => t.id === activeTab)!;
  const isFormTab = activeTab !== "variations";

  return (
    <div className="flex gap-8" data-testid="project-settings-form">
      {/* Sidebar tabs */}
      <nav className="w-52 shrink-0">
        <div className="space-y-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-ring ${
                activeTab === t.id
                  ? "border-l-2 border-brand bg-hover pl-[10px] text-brand-text"
                  : "text-fg-muted hover:bg-hover hover:text-fg"
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content area */}
      <div className="min-w-0 flex-1">
        <div className="rounded-lg bg-raised shadow-raised">
          <div className="border-b border-edge px-6 py-4">
            <h3 className="text-base font-medium text-fg">
              {activeMeta.label}
            </h3>
            <p className="mt-1 text-xs text-fg-muted">{activeMeta.desc}</p>
          </div>
          <div className="p-6">
            {/* Settings form — hidden when on variations tab, stays mounted for RHF */}
            <Form {...form}>
              <form
                onSubmit={form.handleSubmit(onSubmit, onInvalidSwitchTab)}
                className={isFormTab ? "" : "hidden"}
              >
                {/* ── Basics ── */}
                <div
                  className={activeTab === "basics" ? "space-y-4" : "hidden"}
                >
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={LABEL_CLS}>
                          Project name
                        </FormLabel>
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
                        <FormLabel className={LABEL_CLS}>Main branch</FormLabel>
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
                </div>

                {/* ── Diff behavior ── */}
                <div className={activeTab === "diff" ? "space-y-4" : "hidden"}>
                  <FormField
                    control={form.control}
                    name="diffThreshold"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={LABEL_CLS}>
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
                          A run is flagged as changed when its pixel-diff
                          exceeds this threshold. Default 0.10%.
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
                          <FormLabel className={LABEL_CLS}>
                            Dynamic text regions
                          </FormLabel>
                          <FormDescription>
                            Enable regex-anchored ignore regions. For each
                            region tagged &quot;dynamic text&quot;, Furan runs
                            OCR on the candidate screenshot and masks the region
                            only when the extracted text matches the pattern.
                            Adds ~200ms–2s per diff for projects with
                            dynamic-text regions.
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
                          <FormLabel className={LABEL_CLS}>
                            Auto-approve feature branches
                          </FormLabel>
                          <FormDescription>
                            Mark feature-branch runs as approved automatically
                            (use with caution).
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
                </div>

                {/* ── Image comparison ── */}
                <div className={activeTab === "image" ? "space-y-4" : "hidden"}>
                  <FormField
                    control={form.control}
                    name="imageComparison"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={LABEL_CLS}>Algorithm</FormLabel>
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
                            <SelectItem value="odiff">
                              Odiff (default)
                            </SelectItem>
                            <SelectItem value="pixelmatch">
                              Pixelmatch
                            </SelectItem>
                            <SelectItem value="looks_same">
                              Looks-Same
                            </SelectItem>
                            <SelectItem value="vlm">VLM (AI Vision)</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormDescription>
                          Pixel comparison backend. Odiff is the default;
                          Pixelmatch is a widely-used exact-pixel comparator;
                          Looks-Same is perceptual and antialiasing-tolerant;
                          VLM uses an AI vision model for semantic diff
                          analysis.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <EngineKnobsEditor
                    engine={form.watch("imageComparison")}
                    form={form}
                    disabled={isGuest}
                    canEditProvider={isAtLeastAdmin(userRole)}
                    hasApiKey={project.hasVlmApiKey}
                  />
                  <FormField
                    control={form.control}
                    name="imageComparisonConfig"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={LABEL_CLS}>
                          Algorithm config (JSON — advanced)
                        </FormLabel>
                        <FormControl>
                          <textarea
                            {...field}
                            rows={4}
                            className="w-full rounded-md border border-edge bg-canvas px-3 py-2 text-sm font-mono text-fg placeholder:text-fg-muted focus-ring"
                            data-testid="image-config-textarea"
                          />
                        </FormControl>
                        <FormDescription>
                          The structured editor above writes here. Edit directly
                          to set custom keys the structured form doesn't expose,
                          or leave blank for engine defaults. API keys never
                          appear here — use the API Key field.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* ── Limits ── */}
                <div
                  className={activeTab === "limits" ? "space-y-4" : "hidden"}
                >
                  <FormField
                    control={form.control}
                    name="maxBuildAllowed"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={LABEL_CLS}>
                          Max builds retained
                        </FormLabel>
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
                        <FormLabel className={LABEL_CLS}>
                          Max branch lifetime (days)
                        </FormLabel>
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
                </div>

                {/* ── Retention ── */}
                <div
                  className={activeTab === "retention" ? "space-y-4" : "hidden"}
                >
                  <FormField
                    control={form.control}
                    name="retentionDays"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className={LABEL_CLS}>
                          Retention (days)
                        </FormLabel>
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
                          Old runs are deleted after this many days. Enforced
                          nightly by the diff-worker retention job.
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                {/* Save row inside the card */}
                <div className="mt-6 flex justify-end gap-3">
                  {form.formState.isDirty && !update.isPending && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => form.reset()}
                      data-testid="cancel-button"
                    >
                      Cancel
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={isGuest || update.isPending}
                    title={
                      isGuest
                        ? "Guests can't modify project settings"
                        : undefined
                    }
                    data-testid="save-button"
                  >
                    {update.isPending ? "Saving…" : "Save changes"}
                  </Button>
                </div>
              </form>
            </Form>

            {/* ── Variations ── */}
            {activeTab === "variations" && (
              <div className="space-y-6">
                <MergeBaselinesPanel
                  projectId={projectId}
                  userRole={userRole}
                />
                <VariationsList projectId={projectId} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
