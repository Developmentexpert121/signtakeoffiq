import { describe, expect, it } from "vitest";
import {
  RESTROOM_KEYWORDS,
  STAIR_KEYWORDS,
  STAIR_NOISE_TRAILING,
  STAIR_NOISE_MIDDLE,
  ELEVATOR_KEYWORDS,
  VESTIBULE_KEYWORDS,
  CORRIDOR_KEYWORDS,
  VEHICLE_BAY_KEYWORDS,
  MEP_KEYWORDS,
  ASSEMBLY_KEYWORDS,
  VARIABLE_USE_KEYWORDS,
  PUBLIC_FACING_KEYWORDS,
  RESIDENTIAL_UNIT_KEYWORDS,
  DORM_KEYWORDS,
  MEZZANINE_KEYWORDS,
  LOBBY_ENTRY_KEYWORDS,
  DIRECTORY_LOCATION_KEYWORDS,
} from "./rules-engine";

function match(re: RegExp, name: string): boolean {
  return re.test(name.toUpperCase());
}

describe("RESTROOM_KEYWORDS", () => {
  it.each([
    "Men's Restroom",
    "Women's Toilet",
    "Unisex Bathroom",
    "ADA Restroom",
    "Shower/Locker",
    "Lavatory",
    "Mens",
    "Female Restroom",
    "Gender Neutral",
  ])("matches %s", (name) => {
    expect(match(RESTROOM_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Storage", "Conference Room", "Kitchen", "Stair"])("does not match %s", (name) => {
    expect(match(RESTROOM_KEYWORDS, name), name).toBe(false);
  });
});

describe("STAIR_KEYWORDS", () => {
  it.each([
    "Stair 1",
    "Stairwell A",
    "Stairway",
    "Stair Tower",
    "Exit Stair",
    "Comm Stair Flt Safety Tech",
    "Electrical Stair Corridor",
    "Training Aircrew Break Stair",  // noise — keyword still present, noise filter handles rejection
  ])("matches (keyword present) %s", (name) => {
    expect(match(STAIR_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Upstairs Storage", "Office", "Elevator", "Corridor"])("does not match %s", (name) => {
    expect(match(STAIR_KEYWORDS, name), name).toBe(false);
  });
});

describe("STAIR_NOISE_TRAILING", () => {
  it.each([
    "Training Aircrew Break Stair",
    "Janitor Stair",
    "Break Stair",
  ])("flags trailing noise %s", (name) => {
    expect(match(STAIR_NOISE_TRAILING, name), name).toBe(true);
  });

  it.each([
    "Stair 1",
    "Stairwell A",
    "Stairway",
    "Exit Stair",           // starts with EXIT — protected
    "Emergency Stair",      // starts with EMERGENCY — protected
    "Egress Stair",         // starts with EGRESS — protected
    "Comm Stair Flt Safety Tech",  // STAIR is not last word
    "Electrical Stair Corridor",   // STAIR is not last word
  ])("does NOT flag legitimate stair %s", (name) => {
    expect(match(STAIR_NOISE_TRAILING, name), name).toBe(false);
  });
});

describe("STAIR_NOISE_MIDDLE", () => {
  it.each([
    "Men's Stair Mechanical",
    "Mens Stair Break",
    "Jan Stair Break Rm",
  ])("flags middle noise %s", (name) => {
    expect(match(STAIR_NOISE_MIDDLE, name), name).toBe(true);
  });

  it.each([
    "Stair 1",
    "Comm Stair Flt Safety Tech",
    "Electrical Stair Corridor",
    "Exit Stair",
  ])("does NOT flag legitimate stair %s", (name) => {
    expect(match(STAIR_NOISE_MIDDLE, name), name).toBe(false);
  });
});

describe("ELEVATOR_KEYWORDS", () => {
  it.each(["Elevator", "Elev Lobby", "Lift", "Elevator Shaft", "Elev"])("matches %s", (name) => {
    expect(match(ELEVATOR_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Stair", "Office", "Lobby", "Corridor"])("does not match %s", (name) => {
    expect(match(ELEVATOR_KEYWORDS, name), name).toBe(false);
  });
});

describe("VESTIBULE_KEYWORDS", () => {
  it.each(["Vestibule", "Entry Vest", "Exit Vestibule", "Air Lock", "Vest"])("matches %s", (name) => {
    expect(match(VESTIBULE_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Lobby", "Entry", "Stair"])("does not match %s", (name) => {
    expect(match(VESTIBULE_KEYWORDS, name), name).toBe(false);
  });
});

describe("CORRIDOR_KEYWORDS", () => {
  it.each(["Corridor", "Corr", "Hallway", "Hall", "Passage", "Gallery"])("matches %s", (name) => {
    expect(match(CORRIDOR_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Stair", "Lobby", "Storage"])("does not match %s", (name) => {
    expect(match(CORRIDOR_KEYWORDS, name), name).toBe(false);
  });
});

describe("VEHICLE_BAY_KEYWORDS", () => {
  it.each(["Apparatus Bay", "Garage", "Vehicle Bay", "Bay 1", "Drive-Through"])("matches %s", (name) => {
    expect(match(VEHICLE_BAY_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Storage", "Stair", "Lobby"])("does not match %s", (name) => {
    expect(match(VEHICLE_BAY_KEYWORDS, name), name).toBe(false);
  });
});

describe("MEP_KEYWORDS", () => {
  it.each([
    "Mechanical Room",
    "Mech",
    "Electrical Room",
    "Elec",
    "IDF",
    "MDF",
    "Telecom",
    "Server Room",
    "IT Room",
    "Janitor",
    "Jan Closet",
    "Sprinkler Room",
    "Pump Room",
    "Utility Room",
  ])("matches %s", (name) => {
    expect(match(MEP_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Conference Room", "Lobby", "Stair"])("does not match %s", (name) => {
    expect(match(MEP_KEYWORDS, name), name).toBe(false);
  });
});

describe("ASSEMBLY_KEYWORDS", () => {
  it.each([
    "Training Room",
    "Meeting Room",
    "Conference Room",
    "Auditorium",
    "Chapel",
    "Community Room",
    "EOC",
    "Banquet Hall",
    "Dining Room",
    "Assembly Hall",
  ])("matches %s", (name) => {
    expect(match(ASSEMBLY_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Storage", "Stair", "Elevator"])("does not match %s", (name) => {
    expect(match(ASSEMBLY_KEYWORDS, name), name).toBe(false);
  });
});

describe("VARIABLE_USE_KEYWORDS", () => {
  it.each([
    "Training Room",
    "EOC",
    "Community Room",
    "Multi-Purpose Room",
    "Flex Room",
    "Multi Use",
    "Convertible Space",
  ])("matches %s", (name) => {
    expect(match(VARIABLE_USE_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Storage", "Conference Room", "Lobby"])("does not match %s", (name) => {
    expect(match(VARIABLE_USE_KEYWORDS, name), name).toBe(false);
  });
});

describe("PUBLIC_FACING_KEYWORDS", () => {
  it.each(["Lobby", "Public Corridor", "Reception", "Waiting Room", "Front Desk"])("matches %s", (name) => {
    expect(match(PUBLIC_FACING_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Storage", "Stair", "Mechanical Room"])("does not match %s", (name) => {
    expect(match(PUBLIC_FACING_KEYWORDS, name), name).toBe(false);
  });
});

describe("RESIDENTIAL_UNIT_KEYWORDS", () => {
  it.each(["Unit 101", "Apt 4B", "Suite 200"])("matches %s", (name) => {
    expect(match(RESIDENTIAL_UNIT_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office Suite", "Storage Unit", "101 Unit", "The Suite"])("does not match %s", (name) => {
    expect(match(RESIDENTIAL_UNIT_KEYWORDS, name), name).toBe(false);
  });
});

describe("DORM_KEYWORDS", () => {
  it.each(["Dormitory", "Dorm Room", "Bunk Room", "Sleeping Room", "Sleep Area"])("matches %s", (name) => {
    expect(match(DORM_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Conference Room", "Lobby", "Storage"])("does not match %s", (name) => {
    expect(match(DORM_KEYWORDS, name), name).toBe(false);
  });
});

describe("MEZZANINE_KEYWORDS", () => {
  it.each(["Mezzanine", "Mezz", "Level Mezz", "2-Mezz"])("matches %s", (name) => {
    expect(match(MEZZANINE_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Level 1", "Ground Floor", "Basement", "Roof"])("does not match %s", (name) => {
    expect(match(MEZZANINE_KEYWORDS, name), name).toBe(false);
  });
});

describe("LOBBY_ENTRY_KEYWORDS", () => {
  it.each(["Lobby", "Entry", "Entrance", "Main Lobby", "Front Entry"])("matches %s", (name) => {
    expect(match(LOBBY_ENTRY_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Stair", "Corridor", "Storage"])("does not match %s", (name) => {
    expect(match(LOBBY_ENTRY_KEYWORDS, name), name).toBe(false);
  });
});

describe("DIRECTORY_LOCATION_KEYWORDS", () => {
  it.each(["Lobby", "Reception", "Foyer", "Atrium"])("matches %s", (name) => {
    expect(match(DIRECTORY_LOCATION_KEYWORDS, name), name).toBe(true);
  });

  it.each(["Office", "Storage", "Stair", "Training Room", "Hallway", "Hall", "Corridor", "Corr", "Entry"])("does not match %s", (name) => {
    expect(match(DIRECTORY_LOCATION_KEYWORDS, name), name).toBe(false);
  });
});
