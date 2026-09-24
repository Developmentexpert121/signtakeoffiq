import { db } from "@workspace/db";
import { trainingPatternsTable, importSnapshotsTable } from "@workspace/db";
import { eq, and, desc, isNotNull } from "drizzle-orm";
type PatternRow = typeof trainingPatternsTable.$inferSelect;

function parsePatternDescription(p: PatternRow): { signType: string; roomNamePattern: string } {
  const dashIdx = p.description.indexOf(" — ");
  const signType = dashIdx >= 0 ? p.description.slice(0, dashIdx).trim() : p.description.trim();

  const matchingIdx = p.description.indexOf("in rooms matching '");
  let roomNamePattern = "all rooms";
  if (matchingIdx >= 0) {
    const afterQuote = p.description.slice(matchingIdx + "in rooms matching '".length);
    const closeQuote = afterQuote.indexOf("'");
    if (closeQuote >= 0) {
      roomNamePattern = afterQuote.slice(0, closeQuote).trim();
    }
  }

  return { signType, roomNamePattern };
}

export async function getTrainingContext(
  tenantId: string,
  buildingType: string | null,
): Promise<string> {
  const patterns = await db.select()
    .from(trainingPatternsTable)
    .where(and(
      eq(trainingPatternsTable.tenantId, tenantId),
      eq(trainingPatternsTable.status, "approved"),
    ))
    .orderBy(desc(trainingPatternsTable.evidenceCount))
    .limit(15);

  const examples = await db.select()
    .from(importSnapshotsTable)
    .where(and(
      eq(importSnapshotsTable.tenantId, tenantId),
      isNotNull(importSnapshotsTable.accuracyScore),
      ...(buildingType ? [eq(importSnapshotsTable.buildingType, buildingType)] : []),
    ))
    .orderBy(desc(importSnapshotsTable.accuracyScore))
    .limit(3);

  if (patterns.length === 0 && examples.length === 0) return "";

  let context = "The following rules were learned from human-validated takeoffs. Apply them during room extraction and sign assignment. They override your default behavior.\n\n";

  if (patterns.length > 0) {
    context += "KNOWN SIGN TYPE RULES (apply these during extraction):\n";
    for (const p of patterns) {
      const { signType, roomNamePattern } = parsePatternDescription(p);
      context += `- RULE: When extracting rooms, always include ${signType} signs for rooms matching pattern '${roomNamePattern}'. Evidence: ${p.evidenceCount} validated jobs. Type: ${p.patternType}.\n`;
    }
    context += "\n";
  }

  if (examples.length > 0) {
    context += "VALIDATED REFERENCE JOBS (similar building type, human-verified):\n";
    for (const e of examples) {
      const score = e.accuracyScore ? `${Math.round(parseFloat(String(e.accuracyScore)) * 100)}%` : "unknown";
      context += `- ${e.buildingType ?? "Unknown type"} project: ${e.totalHumanSigns ?? "?"} signs, accuracy ${score}\n`;
    }
  }

  return context;
}
