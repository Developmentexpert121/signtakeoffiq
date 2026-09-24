import { useLocation } from "wouter";
import { useCreateJob } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Loader2, Info } from "lucide-react";
import { CANONICAL_BUILDING_TYPES, getBuildingTypeOption } from "@/lib/buildingTypes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const formSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  location: z.string().optional(),
  buildingType: z.string().min(1, "Please select a building type"),
  visionThreshold: z.coerce.number().int().min(0).max(50, "Maximum allowed value is 50").optional(),
});

export default function JobsNew() {
  const [, setLocation] = useLocation();
  const createJob = useCreateJob();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      location: "",
      buildingType: "",
      visionThreshold: undefined,
    },
  });

  const selectedBuildingType = form.watch("buildingType");

  function onSubmit(values: z.infer<typeof formSchema>) {
    createJob.mutate(
      { data: { ...values, visionThreshold: values.visionThreshold !== undefined ? Number(values.visionThreshold) : undefined } },
      { onSuccess: (job) => setLocation(`/jobs/${job.id}`) },
    );
  }

  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6 lg:p-8 w-full">
      <div>
        <Button
          variant="ghost"
          className="mb-4 -ml-4 text-muted-foreground hover:text-foreground"
          onClick={() => window.history.back()}
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <h1 className="text-3xl font-bold tracking-tight">Create New Job</h1>
        <p className="text-muted-foreground mt-1">Initialize a new extraction project.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Project Details</CardTitle>
          <CardDescription>Enter the metadata for this signage extraction job.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

              {/* ── Building Type — required, first field ── */}
              <FormField
                control={form.control}
                name="buildingType"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex items-center gap-2">
                      <FormLabel>Building Type <span className="text-destructive">*</span></FormLabel>
                      {selectedBuildingType && (() => {
                        const guide = getBuildingTypeOption(selectedBuildingType)?.uploadGuide;
                        if (!guide) return null;
                        return (
                          <Popover>
                            <PopoverTrigger asChild>
                              <button type="button" className="rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" aria-label="Upload tips for this building type">
                                <Info className="h-3.5 w-3.5" />
                              </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-80 p-4" side="right" align="start">
                              <div className="flex flex-col gap-3 text-xs">
                                <p className="font-semibold text-sm text-foreground">Upload Guide</p>
                                <div>
                                  <p className="font-medium text-foreground mb-1">Look for:</p>
                                  <ul className="space-y-0.5 text-muted-foreground">
                                    {guide.lookFor.map((item, i) => <li key={i} className="flex gap-1.5"><span className="text-emerald-500 shrink-0">✓</span>{item}</li>)}
                                  </ul>
                                </div>
                                <div>
                                  <p className="font-medium text-foreground mb-1">Avoid:</p>
                                  <ul className="space-y-0.5 text-muted-foreground">
                                    {guide.avoid.map((item, i) => <li key={i} className="flex gap-1.5"><span className="text-red-500 shrink-0">✕</span>{item}</li>)}
                                  </ul>
                                </div>
                                {guide.roomScheduleHint && (
                                  <div className="rounded-md bg-muted/50 px-3 py-2">
                                    <p className="font-medium text-foreground mb-0.5">Room schedule:</p>
                                    <p className="text-muted-foreground">{guide.roomScheduleHint}</p>
                                  </div>
                                )}
                                {guide.signScheduleHint && (
                                  <div className="rounded-md bg-muted/50 px-3 py-2">
                                    <p className="font-medium text-foreground mb-0.5">Sign schedule:</p>
                                    <p className="text-muted-foreground">{guide.signScheduleHint}</p>
                                  </div>
                                )}
                              </div>
                            </PopoverContent>
                          </Popover>
                        );
                      })()}
                    </div>
                    <FormControl>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-2" data-testid="select-job-building-type">
                        {CANONICAL_BUILDING_TYPES.map((bt) => {
                          const isSelected = field.value === bt.value;
                          const isUnknown = bt.value === "unknown";
                          return (
                            <button
                              key={bt.value}
                              type="button"
                              onClick={() => field.onChange(bt.value)}
                              className={cn(
                                "flex flex-col items-center gap-1.5 rounded-lg border-2 p-3 text-center transition-all",
                                isSelected && !isUnknown
                                  ? "border-amber-500 bg-amber-500/10"
                                  : isSelected && isUnknown
                                    ? "border-yellow-400 bg-yellow-400/10"
                                    : isUnknown
                                      ? "border-yellow-600/40 hover:border-yellow-500/70"
                                      : "border-border hover:border-muted-foreground/50"
                              )}
                            >
                              <span className="text-2xl leading-none">{bt.icon}</span>
                              <span className="text-xs font-semibold leading-tight">{bt.label}</span>
                              <span className="text-[10px] leading-tight text-muted-foreground line-clamp-2">{bt.subtitle}</span>
                            </button>
                          );
                        })}
                      </div>
                    </FormControl>
                    {selectedBuildingType === "unknown" && (
                      <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-1">
                        AI will attempt to detect building type from your plans. Select a specific type for best accuracy.
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* ── Project Name ── */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Project Name <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Acme HQ Phase 2" {...field} data-testid="input-job-name" />
                    </FormControl>
                    <FormDescription>Internal reference name for this job.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* ── Location ── */}
              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location</FormLabel>
                    <FormControl>
                      <Input placeholder="City, State" {...field} data-testid="input-job-location" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* ── AI Vision Threshold ── */}
              <FormField
                control={form.control}
                name="visionThreshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>AI Vision Threshold</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={50}
                        placeholder="Default: 3"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value === "" ? undefined : e.target.valueAsNumber)}
                        data-testid="input-vision-threshold"
                      />
                    </FormControl>
                    <FormDescription>
                      Run AI room detection on sheets with fewer than this many rooms found by text parsing. Leave blank to use the default (3).
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex justify-end pt-4 border-t border-border">
                <Button
                  type="submit"
                  disabled={createJob.isPending || !selectedBuildingType}
                  data-testid="btn-submit-job"
                >
                  {createJob.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create Job & Continue
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
