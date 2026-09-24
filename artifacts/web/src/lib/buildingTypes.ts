export interface BuildingTypeOption {
  value: string;
  label: string;
  icon: string;
  subtitle: string;
  uploadGuide?: {
    lookFor: string[];
    avoid: string[];
    roomScheduleHint: string;
    signScheduleHint: string;
  };
}

export const CANONICAL_BUILDING_TYPES: BuildingTypeOption[] = [
  { value: "commercial",  label: "Commercial",  icon: "🏢", subtitle: "Office, retail, airport, mixed-use",
    uploadGuide: {
      lookFor: ["A-1xx sheets (floor plans)", "Finish schedule if included", "Division 10 14 00 sign specs"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "RCP (reflected ceiling)", "Site plans"],
      roomScheduleHint: "Look for a sheet labeled 'Finish Schedule' or 'Room Schedule' — usually A-7xx or FS-xxx.",
      signScheduleHint: "Look for Division 10 14 00 in the spec book, or a sheet labeled 'Signage' or 'SIM'.",
    },
  },
  { value: "residential", label: "Residential", icon: "🏠", subtitle: "Apartments, condos, senior living",
    uploadGuide: {
      lookFor: ["Unit floor plans A-1xx", "Building core and corridor plans", "Amenity floor plans"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "Site plans", "Landscape plans"],
      roomScheduleHint: "Look for a unit schedule or finish plan listing unit numbers and room names.",
      signScheduleHint: "Look for Division 10 14 00 in the spec book, or a tenant signage schedule.",
    },
  },
  { value: "education",   label: "Education",   icon: "🎓", subtitle: "School, university, library, daycare",
    uploadGuide: {
      lookFor: ["A-1xx sheets (e.g. A-101, A-111 — first floor plans)", "A-2xx sheets (second floor)", "A-7xx finish/room schedule (e.g. A-710)"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "RCP (reflected ceiling)", "Site plans"],
      roomScheduleHint: "Look for a sheet labeled 'Room Finish Schedule' or 'Finish Plan' — usually A-710 or A-711.",
      signScheduleHint: "Look for Division 10 14 00 in the spec book, or a sheet labeled 'SIM', 'ID', or 'Signage Types'.",
    },
  },
  { value: "healthcare",  label: "Healthcare",  icon: "🏥", subtitle: "Hospital, clinic, medical office",
    uploadGuide: {
      lookFor: ["A-1xx or FP-1xx floor plans", "Finish schedule A-7xx or FS-xxx", "Division 10 sign specs"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "Medical gas plans", "Equipment plans", "RCP sheets"],
      roomScheduleHint: "Look for a sheet labeled 'Room Finish Schedule' or 'Interior Finish Plan' — often A-710 or FS-100.",
      signScheduleHint: "Look for Division 10 14 00 in the spec book. Healthcare projects often have detailed sign type matrices.",
    },
  },
  { value: "government",  label: "Government",  icon: "🏛️", subtitle: "Municipal, federal, courthouse",
    uploadGuide: {
      lookFor: ["A-1xx floor plans", "Finish schedule A-7xx", "Division 10 14 00 sign specs"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "Civil drawings", "Site plans", "RCP sheets"],
      roomScheduleHint: "Look for a sheet labeled 'Room Finish Schedule' — usually in the A-7xx series.",
      signScheduleHint: "Look for Division 10 14 00 in the spec book. Government projects often include detailed ADA sign specifications.",
    },
  },
  { value: "hotel",       label: "Hotel",       icon: "🏨", subtitle: "Hotel, motel, resort",
    uploadGuide: {
      lookFor: ["A-1xx guest floor plans", "Public space floor plans", "Finish schedule if included"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "Kitchen equipment plans", "RCP sheets"],
      roomScheduleHint: "Look for a room schedule listing guest room numbers and suite types — often in the A-7xx series.",
      signScheduleHint: "Look for Division 10 14 00 or a brand signage standards document included with the specs.",
    },
  },
  { value: "assembly",    label: "Assembly",    icon: "🎭", subtitle: "Church, theater, arena, museum",
    uploadGuide: {
      lookFor: ["A-1xx floor plans showing seating areas, lobbies, and back-of-house", "Finish schedule if included"],
      avoid: ["M- (mechanical)", "P- (plumbing)", "E- (electrical)", "S- (structural)", "Acoustic plans", "Lighting plots", "RCP sheets"],
      roomScheduleHint: "Look for a finish schedule listing room names — often A-7xx or included on the floor plan sheets.",
      signScheduleHint: "Look for Division 10 14 00 or a wayfinding signage specification in the spec book.",
    },
  },
  { value: "unknown",     label: "Unknown",     icon: "❓", subtitle: "Let AI detect from plans",
    uploadGuide: {
      lookFor: ["Floor plan pages showing rooms with labels", "Any finish or room schedule", "Any sign specification document"],
      avoid: ["Mechanical, plumbing, electrical, or structural sheets", "Site plans", "Reflected ceiling plans"],
      roomScheduleHint: "Look for a page with a table listing room numbers and room names.",
      signScheduleHint: "Look for a page or document describing sign types, materials, or mounting requirements.",
    },
  },
];

export function getBuildingTypeOption(value: string | null | undefined): BuildingTypeOption | undefined {
  if (!value) return undefined;
  return CANONICAL_BUILDING_TYPES.find(t => t.value === value);
}

export function getBuildingTypeLabel(value: string | null | undefined): string {
  return getBuildingTypeOption(value)?.label ?? (value ?? "");
}

export function getBuildingTypeIcon(value: string | null | undefined): string {
  return getBuildingTypeOption(value)?.icon ?? "🏢";
}
