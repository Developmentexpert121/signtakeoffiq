import { db } from "@workspace/db";
import { jobsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface JobMaterialSpec {
  jobId:          string;
  substrate:      string | null;
  finishMethod:   string | null;
  brailleSpec:    string | null;
  mountingHeight: string | null;
  manufacturer:   string | null;
  source:         "sign_schedule" | "manual";
}

export async function setJobMaterialSpec(spec: JobMaterialSpec): Promise<void> {
  const { jobId, ...rest } = spec;
  await db.update(jobsTable)
    .set({ materialSpec: rest })
    .where(eq(jobsTable.id, jobId));
}

export async function getJobMaterialSpec(jobId: string): Promise<JobMaterialSpec | null> {
  const [job] = await db.select({ materialSpec: jobsTable.materialSpec })
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));
  if (!job?.materialSpec) return null;
  return { jobId, ...job.materialSpec } as JobMaterialSpec;
}

export async function clearJobMaterialSpec(jobId: string): Promise<void> {
  await db.update(jobsTable)
    .set({ materialSpec: null })
    .where(eq(jobsTable.id, jobId));
}
