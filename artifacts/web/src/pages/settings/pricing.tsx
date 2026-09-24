import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import { useAuthFetch } from "@/hooks/use-auth-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { GripVertical, Plus, Trash2, Save, Loader2, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useCurrentUser } from "@/hooks/use-current-user";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface Material {
  id: string; group: string; name: string; msrp: number; bidPrice: number; isDefault: boolean;
}
interface Finishing {
  id: string; name: string; msrp: number | null; unit: "sqin" | "each"; bidPrice: number | null; includeByDefault: boolean;
}
interface LaserItem {
  id: string; name: string; msrp: number; unit: "sqin" | "sign"; bidPrice: number;
}
interface AdditionalCharge {
  id: string; name: string; msrp: number | null; unit: string; bidPrice: number | null;
}
interface RushFee { oneTwoDay: boolean; threeFourDay: boolean; }
interface Shipping { upTo500: number; over1000: number; }
interface SignDefault {
  signType: string; label: string; width: number; height: number;
  materialId: string; finishingIds: string[]; unitPrice: number; flatPrice?: number;
}
interface CustomProduct {
  id: string; name: string; price: number; priceType: "sqin" | "flat"; notes: string;
}
interface Installation {
  defaultPerSign: number;
  note: string;
  overrides: Record<string, number>;
}
interface PricingSettings {
  materials: Material[]; finishings: Finishing[]; laser: LaserItem[];
  additionalCharges: AdditionalCharge[]; rushFee: RushFee; shipping: Shipping;
  signDefaults: SignDefault[]; customProducts: CustomProduct[];
  installation: Installation;
}

// ─────────────────────────────────────────────
// Default data
// ─────────────────────────────────────────────

const DEFAULT_MATERIALS: Material[] = [
  { id: "rowmark-basic-116", group: "Rowmark", name: 'Rowmark Basic 1/16"', msrp: 0.37, bidPrice: 0.37, isDefault: false },
  { id: "rowmark-basic-18", group: "Rowmark", name: 'Rowmark Basic 1/8"', msrp: 0.53, bidPrice: 0.53, isDefault: true },
  { id: "rowmark-premium-18", group: "Rowmark", name: 'Rowmark Premium 1/8"', msrp: 0.66, bidPrice: 0.66, isDefault: false },
  { id: "p95-white-silver-18", group: "P95 / P99 Acrylic", name: 'P95 White or Brushed Silver 1/8"', msrp: 0.50, bidPrice: 0.50, isDefault: false },
  { id: "p95-black-18", group: "P95 / P99 Acrylic", name: 'P95 Black Acrylic 1/8"', msrp: 0.47, bidPrice: 0.47, isDefault: false },
  { id: "p95-white-black-14", group: "P95 / P99 Acrylic", name: 'P95 White or Black 1/4"', msrp: 0.90, bidPrice: 0.90, isDefault: false },
  { id: "p99-clear-non-glare-18", group: "P95 / P99 Acrylic", name: 'P99 Clear Non-Glare 1/8"', msrp: 0.50, bidPrice: 0.50, isDefault: false },
  { id: "acrylic-ng-116", group: "Clear Acrylic", name: 'Acrylic Non-Glare 1/16"', msrp: 0.41, bidPrice: 0.41, isDefault: false },
  { id: "acrylic-ng-18", group: "Clear Acrylic", name: 'Acrylic Non-Glare 1/8"', msrp: 0.50, bidPrice: 0.50, isDefault: false },
  { id: "acrylic-ng-14", group: "Clear Acrylic", name: 'Acrylic Non-Glare 1/4"', msrp: 0.90, bidPrice: 0.90, isDefault: false },
  { id: "clear-acrylic-38", group: "Clear Acrylic", name: 'Clear Acrylic 3/8"', msrp: 1.30, bidPrice: 1.30, isDefault: false },
  { id: "clear-acrylic-12-p99", group: "Clear Acrylic", name: 'Clear Acrylic 1/2" P99', msrp: 1.69, bidPrice: 1.69, isDefault: false },
  { id: "pvc-18", group: "Other Materials", name: 'PVC / Polystyrene 1/8"', msrp: 0.36, bidPrice: 0.36, isDefault: false },
  { id: "wilsonart-tape", group: "Other Materials", name: 'Wilsonart w/tape .05"', msrp: 0.53, bidPrice: 0.53, isDefault: false },
  { id: "acm-brushed-silver-18", group: "Other Materials", name: 'ACM Brushed Silver Dibond 1/8"', msrp: 0.50, bidPrice: 0.50, isDefault: false },
  { id: "backers-18", group: "Other Materials", name: '1/8" Backers', msrp: 0.42, bidPrice: 0.42, isDefault: false },
  { id: "brushed-aluminum-132", group: "Other Materials", name: 'Brushed Aluminum Rowmark 1/32"', msrp: 0.37, bidPrice: 0.37, isDefault: false },
  { id: "chemetal-black", group: "Other Materials", name: "Chemetal w/ Black Acrylic Backer", msrp: 3.00, bidPrice: 3.00, isDefault: false },
];

const DEFAULT_FINISHINGS: Finishing[] = [
  { id: "raised-copy-braille", name: "Raised Copy w/ or w/o Braille", msrp: 0.73, unit: "sqin", bidPrice: 0.73, includeByDefault: true },
  { id: "cmyk-flat", name: "CMYK Flat Print", msrp: 0.39, unit: "sqin", bidPrice: 0.39, includeByDefault: false },
  { id: "cmyk-plus-white", name: "CMYK Plus White Print", msrp: 0.61, unit: "sqin", bidPrice: 0.61, includeByDefault: false },
  { id: "laser-cut-applique", name: 'Laser Cut Applique 1/32" + Braille', msrp: 0.84, unit: "sqin", bidPrice: 0.84, includeByDefault: false },
  { id: "painted-applique", name: "Painted Applique + Braille", msrp: 0.94, unit: "sqin", bidPrice: 0.94, includeByDefault: false },
  { id: "back-paint-vinyl", name: "Back Paint (incl. vinyl layer)", msrp: 0.52, unit: "sqin", bidPrice: 0.52, includeByDefault: false },
  { id: "back-paint-1st-window", name: "Back Paint 1st Window + mask", msrp: 0.72, unit: "sqin", bidPrice: 0.72, includeByDefault: false },
  { id: "back-paint-addl-window", name: "Back Paint each add'l window", msrp: 5.50, unit: "each", bidPrice: 5.50, includeByDefault: false },
  { id: "accent-bar", name: "Accent Bar (material only)", msrp: 5.50, unit: "each", bidPrice: 5.50, includeByDefault: false },
  { id: "assembly-per-layer", name: "Assembly Per Layer (per touch)", msrp: 5.00, unit: "each", bidPrice: 5.00, includeByDefault: false },
  { id: "magnetic", name: "Magnetic", msrp: 0.53, unit: "sqin", bidPrice: 0.53, includeByDefault: false },
  { id: "beveled-edge-fee", name: "Beveled Edge Setup Fee", msrp: 0.75, unit: "sqin", bidPrice: 0.75, includeByDefault: false },
  { id: "beveled-edge-per-sign", name: "Beveled Edge Setup (per sign)", msrp: 10.00, unit: "each", bidPrice: 10.00, includeByDefault: false },
  { id: "small-studs", name: "Small Studs", msrp: 8.00, unit: "each", bidPrice: 8.00, includeByDefault: false },
  { id: "dinoc-vinyl", name: "Dinoc Vinyl", msrp: 0.75, unit: "sqin", bidPrice: 0.75, includeByDefault: false },
  { id: "frosted-vinyl", name: "Frosted Vinyl", msrp: 0.35, unit: "sqin", bidPrice: 0.35, includeByDefault: false },
  { id: "wilson-art", name: "Wilson Art", msrp: 0.53, unit: "sqin", bidPrice: 0.53, includeByDefault: false },
  { id: "rowmark-wood", name: "Rowmark Wood", msrp: 0.66, unit: "sqin", bidPrice: 0.66, includeByDefault: false },
  { id: "aluminum-080", name: "0.080 Aluminum", msrp: 0.66, unit: "sqin", bidPrice: 0.66, includeByDefault: false },
];

const DEFAULT_LASER: LaserItem[] = [
  { id: "rowmark-116-laser", name: 'Rowmark 1/16" Laser Engraved', msrp: 2.00, unit: "sqin", bidPrice: 2.00 },
  { id: "rowmark-18-laser", name: 'Rowmark 1/8" Laser Engraved', msrp: 2.50, unit: "sqin", bidPrice: 2.50 },
  { id: "min-laser", name: "Minimum laser charge", msrp: 5.00, unit: "sign", bidPrice: 5.00 },
];

const DEFAULT_CHARGES: AdditionalCharge[] = [
  { id: "min-sign", name: "Minimum Sign Price", msrp: 20.00, unit: "each", bidPrice: 20.00 },
  { id: "color-match", name: "Color Match / Color", msrp: 50.00, unit: "each", bidPrice: 50.00 },
  { id: "custom-cmyk", name: "Custom CMYK Image (woodgrain)", msrp: 100.00, unit: "each", bidPrice: 100.00 },
  { id: "takeoff-design", name: "Takeoff & Design Services", msrp: null, unit: "tbd", bidPrice: null },
  { id: "vhb-tape", name: "VHB Tape", msrp: 5.00, unit: "sign", bidPrice: 5.00 },
  { id: "photolum-12x18", name: "Photoluminescent 12×18", msrp: 375.00, unit: "each", bidPrice: 375.00 },
  { id: "nfpa-12x18-rowmark", name: "NFPA 12×18 Rowmark/P95", msrp: 250.00, unit: "each", bidPrice: 250.00 },
  { id: "nfpa-12x18-premium", name: "NFPA 12×18 Premium Rowmark", msrp: 300.00, unit: "each", bidPrice: 300.00 },
  { id: "nfpa-12x18-styrene", name: "NFPA 12×18 Styrene", msrp: 215.00, unit: "each", bidPrice: 215.00 },
  { id: "nfpa-16x20", name: "NFPA 16×20", msrp: 215.00, unit: "each", bidPrice: 215.00 },
];

const DEFAULT_SIGN_DEFAULTS: SignDefault[] = [
  { signType: "room_id", label: "Room ID", width: 6, height: 6, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 45.36 },
  { signType: "restroom", label: "Restroom", width: 6, height: 8, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 60.48 },
  { signType: "exit", label: "Exit Tactile", width: 6, height: 8, materialId: "p95-white-silver-18", finishingIds: ["raised-copy-braille"], unitPrice: 59.04 },
  { signType: "stair", label: "Stair Corridor", width: 6, height: 8, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 60.48 },
  { signType: "stair_landing", label: "Stair Landing", width: 6, height: 12, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 90.72 },
  { signType: "elevator", label: "Elevator", width: 4, height: 6, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 30.24 },
  { signType: "elevator_mach", label: "Elevator Mach Rm", width: 6, height: 6, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 45.36 },
  { signType: "unit_id", label: "Unit ID", width: 4, height: 6, materialId: "rowmark-basic-18", finishingIds: ["raised-copy-braille"], unitPrice: 30.24 },
  { signType: "max_occupancy", label: "Max Occupancy", width: 6, height: 8, materialId: "p95-white-silver-18", finishingIds: ["cmyk-flat"], unitPrice: 42.72 },
  { signType: "evacuation_map", label: "Evacuation Map", width: 0, height: 0, materialId: "", finishingIds: [], unitPrice: 45.00, flatPrice: 45.00 },
  { signType: "accessible_entrance", label: "Accessible Entrance", width: 6, height: 8, materialId: "p95-white-silver-18", finishingIds: ["raised-copy-braille"], unitPrice: 59.04 },
];

const DEFAULT_INSTALLATION: Installation = {
  defaultPerSign: 18.00,
  note: "",
  overrides: { "Elevator": 25.00, "Evacuation Map": 25.00 },
};

const INSTALL_SIGN_TYPES: { key: string; label: string; defaultCost: number }[] = [
  { key: "Room ID",        label: "Room ID",        defaultCost: 18.00 },
  { key: "Restroom",       label: "Restroom",        defaultCost: 18.00 },
  { key: "Exit",           label: "Exit",            defaultCost: 18.00 },
  { key: "Stair Corridor", label: "Stair Corridor",  defaultCost: 18.00 },
  { key: "Stair Landing",  label: "Stair Landing",   defaultCost: 18.00 },
  { key: "Elevator",       label: "Elevator",        defaultCost: 25.00 },
  { key: "Evacuation Map", label: "Evacuation Map",  defaultCost: 25.00 },
  { key: "Unit ID",        label: "Unit ID",         defaultCost: 18.00 },
];

const DEFAULT_SETTINGS: PricingSettings = {
  materials: DEFAULT_MATERIALS,
  finishings: DEFAULT_FINISHINGS,
  laser: DEFAULT_LASER,
  additionalCharges: DEFAULT_CHARGES,
  rushFee: { oneTwoDay: false, threeFourDay: false },
  shipping: { upTo500: 50.00, over1000: 100.00 },
  signDefaults: DEFAULT_SIGN_DEFAULTS,
  customProducts: [],
  installation: DEFAULT_INSTALLATION,
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function fmt(v: number | null | undefined): string {
  if (v == null) return "";
  return v.toFixed(2);
}

function parseBid(s: string): number | null {
  const n = parseFloat(s);
  return isNaN(n) ? null : Math.max(0, n);
}

// ─────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────

export default function PricingSetup() {
  const authFetch = useAuthFetch();
  const { isOwnerOrAbove } = useCurrentUser();
  // Only owners (and super admins) can edit pricing. Standard users may view only.
  const canEdit = isOwnerOrAbove;
  const [settings, setSettings] = useState<PricingSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [installOverridesOpen, setInstallOverridesOpen] = useState(false);
  const dragIndexRef = useRef<number | null>(null);

  // Load saved settings
  useEffect(() => {
    authFetch("/api/pricing/settings")
      .then(r => r.ok ? r.json() : null)
      .then((data: (PricingSettings & { tenantId?: string; updatedAt?: string }) | null) => {
        if (data && data.materials) {
          const { tenantId: _tid, updatedAt: _ua, ...rest } = data;
          setSettings({ ...DEFAULT_SETTINGS, ...rest });
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [authFetch]);

  const save = useCallback(async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const res = await authFetch("/api/pricing/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        toast.success("Pricing settings saved");
      } else {
        toast.error("Failed to save pricing settings");
      }
    } catch {
      toast.error("Failed to save pricing settings");
    } finally {
      setSaving(false);
    }
  }, [authFetch, settings, canEdit]);

  // ── Material helpers ──
  const updateMaterial = (id: string, bidPrice: number) =>
    setSettings(s => ({ ...s, materials: s.materials.map(m => m.id === id ? { ...m, bidPrice } : m) }));
  const selectMaterial = (id: string) =>
    setSettings(s => ({ ...s, materials: s.materials.map(m => ({ ...m, isDefault: m.id === id })) }));

  // ── Finishing helpers ──
  const updateFinishing = (id: string, patch: Partial<Finishing>) =>
    setSettings(s => ({ ...s, finishings: s.finishings.map(f => f.id === id ? { ...f, ...patch } : f) }));

  // ── Laser helpers ──
  const updateLaser = (id: string, bidPrice: number) =>
    setSettings(s => ({ ...s, laser: s.laser.map(l => l.id === id ? { ...l, bidPrice } : l) }));

  // ── Additional charge helpers ──
  const updateCharge = (id: string, bidPrice: number | null) =>
    setSettings(s => ({ ...s, additionalCharges: s.additionalCharges.map(c => c.id === id ? { ...c, bidPrice } : c) }));

  // ── Custom products ──
  const addProduct = () => {
    if (settings.customProducts.length >= 15) return;
    setSettings(s => ({
      ...s,
      customProducts: [...s.customProducts, { id: `custom-${Date.now()}`, name: "", price: 0, priceType: "flat", notes: "" }],
    }));
  };
  const updateProduct = (id: string, patch: Partial<CustomProduct>) =>
    setSettings(s => ({ ...s, customProducts: s.customProducts.map(p => p.id === id ? { ...p, ...patch } : p) }));
  const removeProduct = (id: string) =>
    setSettings(s => ({ ...s, customProducts: s.customProducts.filter(p => p.id !== id) }));

  // ── Sign defaults ──
  const updateSignDefault = (signType: string, patch: Partial<SignDefault>) =>
    setSettings(s => ({ ...s, signDefaults: s.signDefaults.map(d => d.signType === signType ? { ...d, ...patch } : d) }));

  // ── Drag-to-reorder (custom products) ──
  const handleDragStart = (idx: number) => { dragIndexRef.current = idx; };
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from == null || from === idx) return;
    setSettings(s => {
      const arr = [...s.customProducts];
      const [item] = arr.splice(from, 1);
      arr.splice(idx, 0, item);
      dragIndexRef.current = idx;
      return { ...s, customProducts: arr };
    });
  };

  // ── Grouped materials ──
  const groups = Array.from(new Set(settings.materials.map(m => m.group)));

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="w-full py-6 px-4 sm:px-6 lg:px-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Pricing Setup</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {canEdit
              ? "Set your bid prices for materials, finishings, and sign configurations."
              : "View your account's pricing for materials, finishings, and sign configurations."}
          </p>
        </div>
        {canEdit ? (
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Changes
          </Button>
        ) : (
          <Badge variant="secondary">View only</Badge>
        )}
      </div>

      <fieldset disabled={!canEdit} className="space-y-8 border-0 p-0 m-0 min-w-0">

      {/* ─── SECTION 1: BASE MATERIALS ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 1 — Base Materials</CardTitle>
          <CardDescription>Select a default material for all ADA signs. Set your bid price per sq in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {groups.map(group => (
            <div key={group}>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{group}</p>
              <div className="space-y-1">
                {settings.materials.filter(m => m.group === group).map(mat => (
                  <div
                    key={mat.id}
                    className={`flex items-center gap-3 rounded-md px-3 py-2 cursor-pointer transition-colors ${mat.isDefault ? "bg-primary/10 border border-primary/30" : "hover:bg-muted/50"}`}
                    onClick={canEdit ? () => selectMaterial(mat.id) : undefined}
                  >
                    <input
                      type="radio"
                      name="defaultMaterial"
                      checked={mat.isDefault}
                      onChange={() => selectMaterial(mat.id)}
                      className="accent-primary shrink-0"
                    />
                    <span className="flex-1 text-sm">{mat.name}</span>
                    {mat.isDefault && <Badge variant="secondary" className="text-xs">Default</Badge>}
                    <span className="text-xs text-muted-foreground w-24 text-right">MSRP ${fmt(mat.msrp)}/sq in</span>
                    <div className="flex items-center gap-1 w-36" onClick={e => e.stopPropagation()}>
                      <Label className="text-xs text-muted-foreground whitespace-nowrap">Bid $</Label>
                      <Input
                        type="number" min="0" step="0.01" value={fmt(mat.bidPrice)}
                        onChange={e => updateMaterial(mat.id, parseBid(e.target.value) ?? mat.bidPrice)}
                        className="h-7 text-xs w-20"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* ─── SECTION 2: FINISHINGS ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 2 — Finishings</CardTitle>
          <CardDescription>Added per sq in on top of base material. Check to include by default on new jobs.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 gap-y-2 items-center min-w-[460px]">
            <span className="text-xs font-medium text-muted-foreground">Default</span>
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <span className="text-xs font-medium text-muted-foreground text-right">MSRP</span>
            <span className="text-xs font-medium text-muted-foreground text-right">Your Bid Price / sq in</span>

            {settings.finishings.map(f => (
              <Fragment key={f.id}>
                <Checkbox
                  checked={f.includeByDefault}
                  onCheckedChange={v => updateFinishing(f.id, { includeByDefault: !!v })}
                />
                <span className="text-sm">{f.name}</span>
                <span className="text-xs text-muted-foreground text-right whitespace-nowrap">
                  {f.msrp != null ? `$${fmt(f.msrp)} ${f.unit === "each" ? "each" : "/sq in"}` : "—"}
                </span>
                <div className="flex items-center gap-1 justify-end">
                  <Label className="text-xs text-muted-foreground">$</Label>
                  <Input
                    type="number" min="0" step="0.01"
                    value={f.bidPrice != null ? fmt(f.bidPrice) : ""}
                    placeholder={f.unit === "each" ? "each" : "/sq in"}
                    onChange={e => updateFinishing(f.id, { bidPrice: parseBid(e.target.value) })}
                    className="h-7 text-xs w-20"
                  />
                </div>
              </Fragment>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ─── SECTION 3: LASER ENGRAVING ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 3 — Laser Engraving</CardTitle>
          <CardDescription>Per sq in rates — replaces standard finishings when laser engraving is selected.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {settings.laser.map(l => (
              <div key={l.id} className="flex items-center gap-4">
                <span className="flex-1 text-sm">{l.name}</span>
                <span className="text-xs text-muted-foreground w-32 text-right">
                  MSRP ${fmt(l.msrp)}{l.unit === "sqin" ? "/sq in" : "/sign"}
                </span>
                <div className="flex items-center gap-1 w-36">
                  <Label className="text-xs text-muted-foreground">Bid $</Label>
                  <Input
                    type="number" min="0" step="0.01" value={fmt(l.bidPrice)}
                    onChange={e => updateLaser(l.id, parseBid(e.target.value) ?? l.bidPrice)}
                    className="h-7 text-xs w-20"
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ─── SECTION 4: ADDITIONAL CHARGES ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 4 — Additional Charges</CardTitle>
          <CardDescription>Fixed fees and per-sign charges not tied to square inches.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Charge rows */}
          <div className="space-y-2">
            {settings.additionalCharges.map(c => (
              <div key={c.id} className="flex items-center gap-4">
                <span className="flex-1 text-sm">{c.name}</span>
                <span className="text-xs text-muted-foreground w-36 text-right">
                  {c.msrp != null ? `MSRP $${fmt(c.msrp)} ${c.unit}` : "TBD"}
                </span>
                <div className="flex items-center gap-1 w-36">
                  {c.id === "takeoff-design" ? (
                    <Input
                      placeholder="TBD — enter note"
                      value={c.bidPrice != null ? String(c.bidPrice) : ""}
                      onChange={e => updateCharge(c.id, parseBid(e.target.value))}
                      className="h-7 text-xs w-full"
                    />
                  ) : (
                    <>
                      <Label className="text-xs text-muted-foreground">Bid $</Label>
                      <Input
                        type="number" min="0" step="0.01"
                        value={c.bidPrice != null ? fmt(c.bidPrice) : ""}
                        onChange={e => updateCharge(c.id, parseBid(e.target.value))}
                        className="h-7 text-xs w-20"
                      />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>

          <Separator />

          {/* Rush fee toggles */}
          <div>
            <p className="text-sm font-semibold mb-3">Rush Fee Toggles</p>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm">1–2 Business Days</p>
                  <p className="text-xs text-muted-foreground">+100% surcharge</p>
                </div>
                <Switch
                  checked={settings.rushFee.oneTwoDay}
                  onCheckedChange={v => setSettings(s => ({ ...s, rushFee: { ...s.rushFee, oneTwoDay: v } }))}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm">3–4 Business Days</p>
                  <p className="text-xs text-muted-foreground">+50% surcharge</p>
                </div>
                <Switch
                  checked={settings.rushFee.threeFourDay}
                  onCheckedChange={v => setSettings(s => ({ ...s, rushFee: { ...s.rushFee, threeFourDay: v } }))}
                />
              </div>
            </div>
          </div>

          <Separator />

          {/* Shipping */}
          <div>
            <p className="text-sm font-semibold mb-3">Shipping</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Order $500 or less</Label>
                <div className="flex items-center gap-1">
                  <span className="text-sm">$</span>
                  <Input
                    type="number" min="0" step="0.01" value={fmt(settings.shipping.upTo500)}
                    onChange={e => setSettings(s => ({ ...s, shipping: { ...s.shipping, upTo500: parseBid(e.target.value) ?? 50 } }))}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Order over $1,000</Label>
                <div className="flex items-center gap-1">
                  <span className="text-sm">$</span>
                  <Input
                    type="number" min="0" step="0.01" value={fmt(settings.shipping.over1000)}
                    onChange={e => setSettings(s => ({ ...s, shipping: { ...s.shipping, over1000: parseBid(e.target.value) ?? 100 } }))}
                    className="h-8 text-sm"
                  />
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── SECTION 5: INSTALLATION ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 5 — Installation</CardTitle>
          <CardDescription>Default cost per sign for installation labor. Applied to all signs unless overridden.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">

          {/* Default per-sign cost */}
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium">Default Installation Cost per Sign</p>
              <p className="text-xs text-muted-foreground mt-0.5">Applied to all sign types unless a per-type override is set below.</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">$</span>
              <Input
                type="number" min="0" step="0.01"
                value={fmt(settings.installation.defaultPerSign)}
                onChange={e => setSettings(s => ({
                  ...s,
                  installation: { ...s.installation, defaultPerSign: parseBid(e.target.value) ?? 18 },
                }))}
                className="h-8 text-sm w-24"
              />
              <span className="text-xs text-muted-foreground whitespace-nowrap">Per Sign</span>
            </div>
          </div>

          {/* Installation note */}
          <div className="space-y-1.5">
            <Label className="text-sm">
              Installation Note{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              placeholder="e.g. Includes hardware, standard mounting. Travel not included."
              value={settings.installation.note}
              onChange={e => setSettings(s => ({
                ...s,
                installation: { ...s.installation, note: e.target.value },
              }))}
              className="h-8 text-sm"
            />
          </div>

          <Separator />

          {/* Per-type override toggle */}
          <div>
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm font-medium text-foreground w-full text-left hover:text-amber-600 transition-colors"
              onClick={() => setInstallOverridesOpen(v => !v)}
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform duration-150 ${installOverridesOpen ? "rotate-90" : ""}`}
              />
              Set different rates per sign type
            </button>

            {installOverridesOpen && (
              <div className="mt-3 space-y-2 pl-6 border-l-2 border-border ml-2">
                {INSTALL_SIGN_TYPES.map(({ key, label, defaultCost }) => {
                  const val = settings.installation.overrides[key] ?? settings.installation.defaultPerSign;
                  const isOverridden = settings.installation.overrides[key] !== undefined
                    && settings.installation.overrides[key] !== settings.installation.defaultPerSign;
                  return (
                    <div key={key} className="flex items-center gap-4">
                      <span className={`flex-1 text-sm ${isOverridden ? "font-medium" : ""}`}>{label}</span>
                      {isOverridden && (
                        <span className="text-xs text-amber-600 font-medium">override</span>
                      )}
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground">$</span>
                        <Input
                          type="number" min="0" step="0.01"
                          value={fmt(val)}
                          onChange={e => {
                            const v = parseBid(e.target.value) ?? defaultCost;
                            setSettings(s => ({
                              ...s,
                              installation: {
                                ...s.installation,
                                overrides: { ...s.installation.overrides, [key]: v },
                              },
                            }));
                          }}
                          className="h-7 text-xs w-20"
                        />
                      </div>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground pt-1">
                  Leave at default to inherit the value above. Tip: Elevator and Evacuation Map default to $25.00.
                </p>
              </div>
            )}
          </div>

        </CardContent>
      </Card>

      {/* ─── SECTION 6: CUSTOM PRODUCTS ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 6 — Custom Products</CardTitle>
          <CardDescription>Up to 15 custom products. Drag rows to reorder.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.customProducts.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No custom products yet. Add one below.</p>
          )}
          {settings.customProducts.map((p, idx) => (
            <div
              key={p.id}
              draggable={canEdit}
              onDragStart={() => handleDragStart(idx)}
              onDragOver={e => handleDragOver(e, idx)}
              className="flex items-center gap-2 p-2 rounded-md border bg-card hover:bg-muted/40 cursor-grab active:cursor-grabbing"
            >
              <GripVertical className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                placeholder="Product name"
                value={p.name}
                onChange={e => updateProduct(p.id, { name: e.target.value })}
                className="h-7 text-xs flex-1"
              />
              <div className="flex items-center gap-1 w-24">
                <span className="text-xs text-muted-foreground">$</span>
                <Input
                  type="number" min="0" step="0.01" placeholder="0.00"
                  value={p.price > 0 ? fmt(p.price) : ""}
                  onChange={e => updateProduct(p.id, { price: parseBid(e.target.value) ?? 0 })}
                  className="h-7 text-xs"
                />
              </div>
              <Select value={p.priceType} onValueChange={v => updateProduct(p.id, { priceType: v as "sqin" | "flat" })}>
                <SelectTrigger className="h-7 text-xs w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sqin">/ sq in</SelectItem>
                  <SelectItem value="flat">flat</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Notes"
                value={p.notes}
                onChange={e => updateProduct(p.id, { notes: e.target.value })}
                className="h-7 text-xs flex-1"
              />
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => removeProduct(p.id)}>
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          ))}
          {settings.customProducts.length < 15 && (
            <Button variant="outline" size="sm" onClick={addProduct} className="w-full gap-2">
              <Plus className="h-4 w-4" /> Add Product
            </Button>
          )}
        </CardContent>
      </Card>

      {/* ─── SECTION 7: DEFAULT SIGN CONFIGURATION ─── */}
      <Card>
        <CardHeader>
          <CardTitle>Section 7 — Default Sign Configuration</CardTitle>
          <CardDescription>Set the default material and finishing for each sign type. Unit prices update automatically.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {settings.signDefaults.map(sd => {
              const mat = settings.materials.find(m => m.id === sd.materialId);
              const fins = settings.finishings.filter(f => sd.finishingIds.includes(f.id));
              const isFlat = sd.signType === "evacuation_map";
              const sqin = sd.width * sd.height;
              const matCost = mat ? (mat.bidPrice ?? mat.msrp) : 0;
              const finCost = fins.reduce((sum, f) => sum + (f.bidPrice ?? 0) * (f.unit === "sqin" ? 1 : 0), 0);
              const computedUnit = isFlat ? (sd.flatPrice ?? sd.unitPrice) : (matCost + finCost) * sqin;

              return (
                <div key={sd.signType} className="rounded-md border p-4 space-y-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm">{sd.label}</p>
                      {!isFlat && <p className="text-xs text-muted-foreground">{sd.width}″ × {sd.height}″ = {sqin} sq in</p>}
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Est. unit price</p>
                      <p className="text-lg font-bold">${computedUnit.toFixed(2)}</p>
                    </div>
                  </div>

                  {isFlat ? (
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground">Flat price</Label>
                      <span className="text-xs">$</span>
                      <Input
                        type="number" min="0" step="0.01" value={fmt(sd.flatPrice ?? sd.unitPrice)}
                        onChange={e => updateSignDefault(sd.signType, { flatPrice: parseBid(e.target.value) ?? 0, unitPrice: parseBid(e.target.value) ?? 0 })}
                        className="h-7 text-xs w-24"
                      />
                      <span className="text-xs text-muted-foreground">each (frame only)</span>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Material</Label>
                        <Select value={sd.materialId} onValueChange={v => updateSignDefault(sd.signType, { materialId: v })}>
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Select material" />
                          </SelectTrigger>
                          <SelectContent>
                            {settings.materials.map(m => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.name} (${fmt(m.bidPrice)})
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs text-muted-foreground">Finishing</Label>
                        <Select
                          value={sd.finishingIds[0] ?? "__none__"}
                          onValueChange={v => updateSignDefault(sd.signType, { finishingIds: v === "__none__" ? [] : [v] })}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Select finishing" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {settings.finishings.filter(f => f.unit === "sqin").map(f => (
                              <SelectItem key={f.id} value={f.id}>
                                {f.name} (${fmt(f.bidPrice)}/sq in)
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      </fieldset>

      {/* Bottom save */}
      {canEdit && (
        <div className="flex justify-end pb-8">
          <Button onClick={save} disabled={saving} size="lg">
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save All Changes
          </Button>
        </div>
      )}
    </div>
  );
}
