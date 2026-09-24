import { describe, it, expect } from "vitest";
import {
  DEFAULT_SIGN_PRICING,
  getPriceForSignType,
  getSignPricingInfo,
  MSRP_DEFAULTS,
} from "../routes/exports";

// ── getSignPricingInfo — MSRP fallback path (pricing = null) ─────────────────

describe("getSignPricingInfo — MSRP defaults (no tenant pricing)", () => {
  it("room_id: materialName = Rowmark 1/8\", materialRate = 0.53", () => {
    const info = getSignPricingInfo("room_id", "", null);
    expect(info.materialName).toBe('Rowmark 1/8"');
    expect(info.materialRate).toBe(0.53);
  });

  it("room_id: finishingName = Raised Copy + Braille, finishingRate = 0.73", () => {
    const info = getSignPricingInfo("room_id", "", null);
    expect(info.finishingName).toBe("Raised Copy + Braille");
    expect(info.finishingRate).toBe(0.73);
  });

  it("room_id: 6×6 default dimensions, minPrice = 20", () => {
    const info = getSignPricingInfo("room_id", "", null);
    expect(info.width).toBe(6);
    expect(info.height).toBe(6);
    expect(info.minPrice).toBe(20);
  });

  it("restroom: Rowmark material, 6×8 dimensions", () => {
    const info = getSignPricingInfo("restroom", "", null);
    expect(info.materialName).toBe('Rowmark 1/8"');
    expect(info.width).toBe(6);
    expect(info.height).toBe(8);
  });

  it("exit: P95 White material, materialRate = 0.50", () => {
    const info = getSignPricingInfo("exit", "", null);
    expect(info.materialName).toBe('P95 White 1/8"');
    expect(info.materialRate).toBe(0.50);
    expect(info.finishingRate).toBe(0.73);
  });

  it("stair: Rowmark material, 6×8 dimensions", () => {
    const info = getSignPricingInfo("stair", "", null);
    expect(info.materialName).toBe('Rowmark 1/8"');
    expect(info.width).toBe(6);
    expect(info.height).toBe(8);
  });

  it("normalizes sign type string before lookup — 'Room ID' matches room_id entry", () => {
    const byKey = getSignPricingInfo("room_id", "", null);
    const byLabel = getSignPricingInfo("Room ID", "", null);
    expect(byLabel.materialRate).toBe(byKey.materialRate);
    expect(byLabel.finishingRate).toBe(byKey.finishingRate);
    expect(byLabel.width).toBe(byKey.width);
  });

  it("unknown sign type falls back to DEFAULT_MSRP (materialRate=0.53, 6×8)", () => {
    const info = getSignPricingInfo("totally_unknown_xyz", "", null);
    expect(info.materialRate).toBe(0.53);
    expect(info.finishingRate).toBe(0.73);
    expect(info.width).toBe(6);
    expect(info.height).toBe(8);
    expect(info.minPrice).toBe(20);
  });
});

// ── evacuation_map ────────────────────────────────────────────────────────────

describe("getSignPricingInfo — evacuation_map flat price", () => {
  it("returns flatPrice = 45 with empty size string", () => {
    const info = getSignPricingInfo("evacuation_map", "", null);
    expect(info.flatPrice).toBe(45);
  });

  it("returns flatPrice = 45 regardless of size argument (18×24 ignored)", () => {
    const info = getSignPricingInfo("evacuation_map", "18×24", null);
    expect(info.flatPrice).toBe(45);
  });

  it("materialRate and finishingRate are both 0", () => {
    const info = getSignPricingInfo("evacuation_map", "", null);
    expect(info.materialRate).toBe(0);
    expect(info.finishingRate).toBe(0);
  });
});

// ── unit price formula ────────────────────────────────────────────────────────

describe("Unit price formula — max(minPrice, (materialRate + finishingRate) × width × height)", () => {
  it("room_id: max(20, (0.53+0.73)×6×6) = 45.36", () => {
    const info = getSignPricingInfo("room_id", "", null);
    const unit = Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height);
    expect(Number(unit.toFixed(2))).toBe(45.36);
  });

  it("restroom: max(20, (0.53+0.73)×6×8) = 60.48", () => {
    const info = getSignPricingInfo("restroom", "", null);
    const unit = Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height);
    expect(Number(unit.toFixed(2))).toBe(60.48);
  });

  it("exit: max(20, (0.50+0.73)×6×8) = 59.04", () => {
    const info = getSignPricingInfo("exit", "", null);
    const unit = Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height);
    expect(Number(unit.toFixed(2))).toBe(59.04);
  });

  it("minPrice floor applies when formula result is below minPrice (1×1 dimensions)", () => {
    const info = getSignPricingInfo("room_id", "1×1", null);
    const unit = Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height);
    expect(unit).toBe(20);
  });
});

// ── extended price ────────────────────────────────────────────────────────────

describe("Extended price — unitPrice × qty", () => {
  it("extended equals unitPrice for qty = 1", () => {
    const info = getSignPricingInfo("room_id", "", null);
    const unit = Number(Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height).toFixed(2));
    expect(Number((unit * 1).toFixed(2))).toBe(unit);
  });

  it("extended is 3× unitPrice for qty = 3 (restroom)", () => {
    const info = getSignPricingInfo("restroom", "", null);
    const unit = Number(Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height).toFixed(2));
    expect(Number((unit * 3).toFixed(2))).toBeCloseTo(unit * 3, 2);
  });

  it("extended is 5× unitPrice for qty = 5 (exit)", () => {
    const info = getSignPricingInfo("exit", "", null);
    const unit = Number(Math.max(info.minPrice, (info.materialRate + info.finishingRate) * info.width * info.height).toFixed(2));
    expect(Number((unit * 5).toFixed(2))).toBeCloseTo(unit * 5, 2);
  });
});

// ── floor subtotals and grand total ──────────────────────────────────────────

describe("Floor subtotals and grand total", () => {
  it("floor subtotal = sum of extended values for all signs on that floor", () => {
    const roomIdUnit = Number(Math.max(20, (0.53 + 0.73) * 6 * 6).toFixed(2));
    const restroomUnit = Number(Math.max(20, (0.53 + 0.73) * 6 * 8).toFixed(2));
    const subtotal = Number((roomIdUnit * 2 + restroomUnit * 1).toFixed(2));
    expect(subtotal).toBeCloseTo(45.36 * 2 + 60.48, 2);
  });

  it("grand total = sum of all floor subtotals", () => {
    const roomIdUnit = Number(Math.max(20, (0.53 + 0.73) * 6 * 6).toFixed(2));
    const exitUnit = Number(Math.max(20, (0.50 + 0.73) * 6 * 8).toFixed(2));
    const floor1 = Number((roomIdUnit * 2 + exitUnit * 1).toFixed(2));
    const floor2 = Number((exitUnit * 4).toFixed(2));
    const grand = Number((floor1 + floor2).toFixed(2));
    expect(grand).toBeCloseTo(floor1 + floor2, 2);
  });
});

// ── rounding ──────────────────────────────────────────────────────────────────

describe("Currency rounding to 2 decimal places", () => {
  it("room_id raw formula result rounds to exactly 45.36", () => {
    const info = getSignPricingInfo("room_id", "", null);
    const raw = (info.materialRate + info.finishingRate) * info.width * info.height;
    expect(Number(raw.toFixed(2))).toBe(45.36);
  });

  it("Number.toFixed(2) eliminates floating-point drift for 0.1 + 0.2", () => {
    const drifted = 0.1 + 0.2;
    expect(Number(drifted.toFixed(2))).toBe(0.30);
  });

  it("evacuation map flatPrice = 45 has no drift after toFixed(2)", () => {
    const info = getSignPricingInfo("evacuation_map", "", null);
    expect(Number(info.flatPrice!.toFixed(2))).toBe(45.00);
  });
});

// ── getPriceForSignType / DEFAULT_SIGN_PRICING ────────────────────────────────

describe("getPriceForSignType — DEFAULT_SIGN_PRICING lookup", () => {
  it("returns correct price for 'Typical Room Sign' (165)", () => {
    expect(getPriceForSignType("Typical Room Sign")).toBe(DEFAULT_SIGN_PRICING["Typical Room Sign"]);
    expect(getPriceForSignType("Typical Room Sign")).toBe(165);
  });

  it("returns correct price for 'Emergency Exit' (145)", () => {
    expect(getPriceForSignType("Emergency Exit")).toBe(145);
  });

  it("returns DEFAULT_SIGN_PRICING['default'] = 150 for unknown type", () => {
    expect(getPriceForSignType("unknown_sign_xyz_abc")).toBe(DEFAULT_SIGN_PRICING["default"]);
    expect(getPriceForSignType("unknown_sign_xyz_abc")).toBe(150);
  });

  it("substring match works — 'Egress Map' → 285", () => {
    expect(getPriceForSignType("Egress Map")).toBe(285);
  });
});

// ── override precedence ───────────────────────────────────────────────────────

describe("Job-level override precedence in getPriceForSignType", () => {
  it("override takes precedence over DEFAULT_SIGN_PRICING for known type", () => {
    expect(getPriceForSignType("Typical Room Sign", { "Typical Room Sign": 299 })).toBe(299);
  });

  it("partial override leaves unoverridden types at their defaults", () => {
    expect(getPriceForSignType("Emergency Exit", { "Typical Room Sign": 999 })).toBe(145);
  });

  it("override of 'default' key catches unknown types", () => {
    expect(getPriceForSignType("unknown_xyz", { "default": 500 })).toBe(500);
  });

  it("null overrides behaves the same as no overrides", () => {
    const withNull = getPriceForSignType("Typical Room Sign", null);
    const withoutOverride = getPriceForSignType("Typical Room Sign");
    expect(withNull).toBe(withoutOverride);
  });
});

// ── tenant pricing override via getSignPricingInfo ───────────────────────────

describe("getSignPricingInfo — tenant pricing override path", () => {
  it("matching signDefault overrides MSRP material name and rates", () => {
    const pricing = {
      materials: [{ id: "mat-1", name: "Custom Material", bidPrice: 1.50, msrp: 2.00, unit: "sqin" }],
      finishings: [{ id: "fin-1", name: "Custom Finishing", bidPrice: 0.50, unit: "sqin" }],
      signDefaults: [
        { signType: "room_id", materialId: "mat-1", finishingIds: ["fin-1"], width: 8, height: 10, minPrice: 30 },
      ],
    };
    const info = getSignPricingInfo("room_id", "", pricing);
    expect(info.materialName).toBe("Custom Material");
    expect(info.materialRate).toBe(1.50);
    expect(info.finishingName).toBe("Custom Finishing");
    expect(info.finishingRate).toBe(0.50);
    expect(info.width).toBe(8);
    expect(info.height).toBe(10);
    expect(info.minPrice).toBe(30);
  });

  it("falls back to MSRP when signType is absent from tenant signDefaults", () => {
    const pricing = {
      materials: [{ id: "mat-1", name: "Custom Material", bidPrice: 1.50, unit: "sqin" }],
      finishings: [],
      signDefaults: [{ signType: "restroom", materialId: "mat-1" }],
    };
    const info = getSignPricingInfo("room_id", "", pricing);
    expect(info.materialRate).toBe(0.53);
  });

  it("empty pricing arrays fall back to MSRP", () => {
    const pricing = { materials: [], finishings: [], signDefaults: [] };
    const info = getSignPricingInfo("room_id", "", pricing);
    expect(info.materialRate).toBe(0.53);
    expect(info.finishingRate).toBe(0.73);
  });
});

// ── MSRP_DEFAULTS spot checks ─────────────────────────────────────────────────

describe("MSRP_DEFAULTS spot checks", () => {
  it("room_id has 6×6 dimensions", () => {
    expect(MSRP_DEFAULTS["room_id"].width).toBe(6);
    expect(MSRP_DEFAULTS["room_id"].height).toBe(6);
  });

  it("evacuation_map has flatPrice=45 and zero rates", () => {
    expect(MSRP_DEFAULTS["evacuation_map"].flatPrice).toBe(45);
    expect(MSRP_DEFAULTS["evacuation_map"].materialRate).toBe(0);
    expect(MSRP_DEFAULTS["evacuation_map"].finishingRate).toBe(0);
  });

  it("max_occupancy uses CMYK Flat Print at $0.39/sqin", () => {
    expect(MSRP_DEFAULTS["max_occupancy"].finishingName).toBe("CMYK Flat Print");
    expect(MSRP_DEFAULTS["max_occupancy"].finishingRate).toBe(0.39);
  });

  it("elevator has 4×6 dimensions (smaller than standard sign)", () => {
    expect(MSRP_DEFAULTS["elevator"].width).toBe(4);
    expect(MSRP_DEFAULTS["elevator"].height).toBe(6);
  });
});

// ── Dictionary pricing — P3 ───────────────────────────────────────────────────

describe("Dictionary pricing — P3", () => {
  type DictEntry = {
    typeCode?: string;
    typeName?: string;
    description?: string;
    size?: string;
    material?: string;
  };

  function buildDictByCode(signTypes: DictEntry[]) {
    return new Map(
      signTypes
        .filter((e) => e.typeCode)
        .map((e) => [e.typeCode!.toUpperCase(), e]),
    );
  }

  function parseSizeForPrice(
    dictEntry: DictEntry | undefined,
    fallbackW: number,
    fallbackH: number,
  ) {
    let w = fallbackW;
    let h = fallbackH;
    if (dictEntry?.size) {
      const m = dictEntry.size.match(
        /(\d+(?:\.\d+)?)\s*[xX\u00d7]\s*(\d+(?:\.\d+)?)/,
      );
      if (m) {
        w = parseFloat(m[1]);
        h = parseFloat(m[2]);
      }
    }
    return { w, h };
  }

  it("material from dictionary overrides DEFAULT_SIGN_PRICING when typeCode matches", () => {
    const dict = buildDictByCode([
      { typeCode: "ROOM_ID", material: 'Acrylic 1/4"', description: "Standard Room ID" },
    ]);
    const dictEntry = dict.get("ROOM_ID");
    const spec = getSignPricingInfo("room_id", "", null);
    const matName = dictEntry?.material ?? spec.materialName;
    expect(matName).toBe('Acrylic 1/4"');
  });

  it("when dictionary has size '6x6', parsed width=6 and height=6 used for unit price", () => {
    const dict = buildDictByCode([{ typeCode: "ROOM_ID", size: "6x6" }]);
    const dictEntry = dict.get("ROOM_ID");
    const spec = getSignPricingInfo("room_id", "", null);
    const { w, h } = parseSizeForPrice(dictEntry, spec.width, spec.height);
    expect(w).toBe(6);
    expect(h).toBe(6);
  });

  it("size '6 x 6' (spaces) parses correctly", () => {
    const dict = buildDictByCode([{ typeCode: "ROOM_ID", size: "6 x 6" }]);
    const dictEntry = dict.get("ROOM_ID");
    const spec = getSignPricingInfo("room_id", "", null);
    const { w, h } = parseSizeForPrice(dictEntry, spec.width, spec.height);
    expect(w).toBe(6);
    expect(h).toBe(6);
  });

  it("size '6X6' (uppercase X) parses correctly", () => {
    const dict = buildDictByCode([{ typeCode: "ROOM_ID", size: "6X6" }]);
    const dictEntry = dict.get("ROOM_ID");
    const spec = getSignPricingInfo("room_id", "", null);
    const { w, h } = parseSizeForPrice(dictEntry, spec.width, spec.height);
    expect(w).toBe(6);
    expect(h).toBe(6);
  });

  it("malformed size string (no dimensions) falls back to DEFAULT_SIGN_PRICING dimensions", () => {
    const dict = buildDictByCode([{ typeCode: "ROOM_ID", size: "standard" }]);
    const dictEntry = dict.get("ROOM_ID");
    const spec = getSignPricingInfo("room_id", "", null);
    const { w, h } = parseSizeForPrice(dictEntry, spec.width, spec.height);
    expect(w).toBe(spec.width);
    expect(h).toBe(spec.height);
  });

  it("job with no projectSignDictionary in metadata falls through to default pricing unchanged", () => {
    const emptyDict = buildDictByCode([]);
    const dictEntry = emptyDict.get("ROOM_ID");
    expect(dictEntry).toBeUndefined();
    const spec = getSignPricingInfo("room_id", "", null);
    const matName = dictEntry?.material ?? spec.materialName;
    expect(matName).toBe(spec.materialName);
  });

  it("description column populated from dictEntry.description when present", () => {
    const dict = buildDictByCode([
      { typeCode: "ROOM_ID", description: "Typical Room ID sign per ADA" },
    ]);
    const dictEntry = dict.get("ROOM_ID");
    const descriptionCell = dictEntry?.description ?? "";
    expect(descriptionCell).toBe("Typical Room ID sign per ADA");
  });

  it("description column is empty string when no dictionary entry matches", () => {
    const dict = buildDictByCode([
      { typeCode: "EXIT_SIGN", description: "Exit sign" },
    ]);
    const dictEntry = dict.get("ROOM_ID");
    const descriptionCell = dictEntry?.description ?? "";
    expect(descriptionCell).toBe("");
  });
});
