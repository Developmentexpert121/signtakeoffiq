import { describe, expect, it } from "vitest";

import { deduplicateScheduleGlobal, deduplicateSchedulePerSheet, deduplicateSignSchedule } from "./dedup";
import { parseAggregateCountTable } from "./schedule-parser";

describe("parseAggregateCountTable", () => {
  it("parses aggregate signage count tables and excludes grand-total rows", () => {
    const table = [
      ["SIGNAGE TYPE", "TYPE MARK", "COUNT"],
      ["ASSISTIVE LISTENING SYSTEM", "ALS", "1"],
      ["CAMPUS COMMONS ELEVATOR ACCESS", "CCE", "2"],
      ["MAXIMUM OCCUPANCY", "MO", "2"],
      ["ELEVATOR EVACUATION NOTICE", "EV-1", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-2", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-3", "1"],
      ["EGRESS MAP", "EV-7", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-4", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-5", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-6", "1"],
      ["ELEVATOR", "EL", "10"],
      ["EMERGENCY COMMUNICATION", "EC", "12"],
      ["EMERGENCY COMMUNICATION CALL BOX", "ECC", "12"],
      ["EXIT STAIR", "ES", "23"],
      ["FLOOR DIRECTORY", "FD", "12"],
      ["RESTROOM", "R", "147"],
      ["EXIT FLOOR 1 - NO ROOF ACCESS", "SE", "20"],
      ["", "", ""],
      ["Grand total:", "", "248"],
    ];

    const entries = parseAggregateCountTable([table], "A700");

    expect(entries).toHaveLength(17);
    expect(entries.find((entry) => entry.signType === "RESTROOM")?.quantity).toBe(147);
    expect(entries.find((entry) => entry.signType === "RESTROOM")?.typeMark).toBe("R");
    expect(entries.find((entry) => entry.signType === "EXIT STAIR")?.quantity).toBe(23);
    expect(entries.filter((entry) => entry.signType === "ELEVATOR EVACUATION NOTICE")).toHaveLength(6);
    expect(entries.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(248);
    expect(entries.some((entry) => /grand/i.test(entry.signType))).toBe(false);
  });

  it("keeps repeated signage descriptions when type marks differ during dedup", () => {
    const entries = parseAggregateCountTable([[
      ["SIGNAGE TYPE", "TYPE MARK", "COUNT"],
      ["ELEVATOR EVACUATION NOTICE", "EV-1", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-2", "1"],
      ["ELEVATOR EVACUATION NOTICE", "EV-3", "1"],
    ]], "A700");

    deduplicateSchedulePerSheet(entries);
    deduplicateScheduleGlobal(entries);
    deduplicateSignSchedule(entries);

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.typeMark)).toEqual(["EV-1", "EV-2", "EV-3"]);
  });

  it("does not parse normal per-room schedule tables", () => {
    const perRoomTable = [
      ["ROOM #", "ROOM NAME", "SIGN TYPE", "QTY"],
      ["101", "Office", "Room ID", "1"],
      ["102", "Restroom", "Restroom", "1"],
    ];

    expect(parseAggregateCountTable([perRoomTable], "A701")).toEqual([]);
  });
});
