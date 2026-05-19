"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
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
  l2Enabled: z.boolean(),
  autoApproveFeature: z.boolean(),
  imageComparison: z.enum(["pixelmatch", "looks_same", "odiff"]),
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
      l2Enabled: true,
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
        l2Enabled: project.l2Enabled ?? true,
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
      <div className="text-sm text-muted-foreground">Loading settings…</div>
    );
  }
  if (error) {
    return (
      <div className="text-sm text-destructive">Error: {error.message}</div>
    );
  }
  if (!project) {
    return (
      <div className="text-sm text-muted-foreground">No project data.</div>
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
              name="l2Enabled"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between gap-4">
                  <div>
                    <FormLabel>Layout-aware comparison</FormLabel>
                    <FormDescription>
                      Analyze DOM structure changes in addition to pixel
                      differences. Helps catch layout regressions that look
                      similar pixel-by-pixel. Adds ~50ms per check.
                    </FormDescription>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      data-testid="l2-enabled-switch"
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
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger data-testid="image-comparison-select">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="odiff">Odiff (default)</SelectItem>
                      <SelectItem value="pixelmatch">Pixelmatch</SelectItem>
                      <SelectItem value="looks_same">Looks-Same</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    L1 pixel comparison backend. Odiff is the default;
                    Pixelmatch matches the jest-image-snapshot / Percy world;
                    Looks-Same is perceptual and antialiasing-tolerant.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="imageComparisonConfig"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Algorithm config (JSON)</FormLabel>
                  <FormControl>
                    <textarea
                      {...field}
                      rows={4}
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                      data-testid="image-config-textarea"
                    />
                  </FormControl>
                  <FormDescription>
                    Algorithm-specific JSON. Leave empty for defaults.
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
                    Old runs are deleted after this many days. Enforcement lands
                    in v0.5.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={isGuest || update.isPending}
            title={isGuest ? "Guests can't modify project settings" : undefined}
            data-testid="save-button"
          >
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
