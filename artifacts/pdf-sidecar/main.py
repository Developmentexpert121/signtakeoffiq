"""
PDF Processing Sidecar for Sign Takeoff IQ
Exposes:
  POST /extract-words   - extract words + positions from a PDF page
  POST /rasterize       - rasterize PDF pages to PNG bytes
  POST /parse-index     - parse drawing index/sheet list from a PDF
"""
import os
import io
import re
import json
import base64
import hashlib
import threading
import traceback
import multiprocessing as mp
import queue as _queue
from collections import OrderedDict
from typing import Optional

import pdfplumber
from PIL import Image as _PILImage

# Rasterizer: prefer poppler (pdf2image); fall back to the self-contained
# pypdfium2 (bundles its own PDFium binary) when poppler isn't installed —
# e.g. local dev on a machine without poppler-utils. Same call signature.
try:
    import shutil as _shutil
    from pdf2image import convert_from_bytes as _poppler_convert
    _HAS_POPPLER = _shutil.which("pdftoppm") is not None
except Exception:
    _poppler_convert = None
    _HAS_POPPLER = False

if _HAS_POPPLER:
    convert_from_bytes = _poppler_convert
else:
    import pypdfium2 as _pdfium

    # PDFium's C API is NOT thread-safe: concurrent document/page access from
    # Starlette's threadpool corrupts its internal state and aborts natively
    # (SIGTRAP in CPDF_Page::~CPDF_Page). The poppler path above is immune
    # because pdf2image shells out to a subprocess; this in-process fallback
    # must serialize every PDFium touch behind a single global lock.
    import threading as _threading
    _pdfium_lock = _threading.Lock()

    def convert_from_bytes(raw, dpi=150, first_page=1, last_page=None, fmt="PNG"):
        scale = dpi / 72.0
        with _pdfium_lock:
            pdf = _pdfium.PdfDocument(raw)
            try:
                n = len(pdf)
                start = (first_page or 1) - 1
                end = (last_page or n)
                out = []
                for i in range(start, min(end, n)):
                    bitmap = pdf[i].render(scale=scale)
                    out.append(bitmap.to_pil().convert("RGB"))
                return out
            finally:
                pdf.close()
from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Raise PIL's decompression-bomb limit — large architectural floor plans
# (300+ DPI, ANSI E sheets) frequently exceed the default 89 MP threshold.
_PILImage.MAX_IMAGE_PIXELS = None

app = FastAPI(title="Sign Takeoff IQ — PDF Sidecar")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1", "http://localhost"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Concurrency + short-lived result cache  (Phase 1 / S1)
# ---------------------------------------------------------------------------
#
# Endpoints below are plain `def` (not `async def`), so Starlette runs each in
# its threadpool — requests no longer serialize on the event loop. poppler
# (pdf2image) shells out and releases the GIL, giving genuine parallel renders.
#
# Two guards keep that concurrency safe and cheap:
#   * a BoundedSemaphore caps simultaneous heavy render/parse work so a burst of
#     large (80+ MP, MAX_IMAGE_PIXELS-disabled) sheets can't exhaust memory.
#   * a byte-bounded LRU caches expensive derived output keyed by the PDF's
#     content hash, so the same page rasterized in two pipeline steps — or the
#     same file re-uploaded on a later request — is rendered only once.

SIDECAR_MAX_CONCURRENCY = max(1, int(os.environ.get("SIDECAR_MAX_CONCURRENCY", "4")))
_work_sem = threading.BoundedSemaphore(SIDECAR_MAX_CONCURRENCY)

# /extract-table hard guards.  pdfplumber's table finder is pure-Python and
# uncancellable; on dense architectural floor plans it can pin a core for minutes.
# Two guards keep it bounded:
#   * SIDECAR_TABLE_DEADLINE_S — the extraction runs in a child process that is
#     TERMINATED past this wall-clock budget, so the CPU is actually freed (an
#     aborted HTTP request alone does not stop the work).
#   * SIDECAR_TABLE_MAX_CHARS — for speculative "text"-strategy scans, a page with
#     more than this many characters is a drawing, not a schedule; skip the
#     expensive find entirely and return 0 tables.
SIDECAR_TABLE_DEADLINE_S = float(os.environ.get("SIDECAR_TABLE_DEADLINE_S", "15"))
SIDECAR_TABLE_MAX_CHARS = int(os.environ.get("SIDECAR_TABLE_MAX_CHARS", "6000"))

_CACHE_MAX_BYTES = int(os.environ.get("SIDECAR_CACHE_MAX_BYTES", str(512 * 1024 * 1024)))
_cache_lock = threading.Lock()
# key -> (size_bytes, value).  OrderedDict gives O(1) LRU move/evict.
_cache: "OrderedDict[str, tuple[int, object]]" = OrderedDict()
_cache_bytes = 0


def _pdf_hash(raw: bytes) -> str:
    """Content hash of the uploaded PDF — cache key prefix. Any byte change misses."""
    return hashlib.sha1(raw).hexdigest()


def _cache_get(key: str):
    """Return the cached value for `key` (and mark it most-recently-used), or None."""
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        _cache.move_to_end(key)
        return hit[1]


def _cache_put(key: str, value, size: int) -> None:
    """Insert `value` (≈`size` bytes) and evict oldest entries past the byte budget."""
    global _cache_bytes
    if size > _CACHE_MAX_BYTES:
        return  # a single item bigger than the whole budget is never worth caching
    with _cache_lock:
        if key in _cache:
            _cache_bytes -= _cache[key][0]
            del _cache[key]
        _cache[key] = (size, value)
        _cache_bytes += size
        while _cache_bytes > _CACHE_MAX_BYTES and _cache:
            _evicted_key, (old_size, _old_val) = _cache.popitem(last=False)
            _cache_bytes -= old_size


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class Word(BaseModel):
    text: str
    x0: float
    y0: float
    x1: float
    y1: float
    page: int


class ExtractWordsResponse(BaseModel):
    words: list[Word]
    page_width: float
    page_height: float


class RasterizeResponse(BaseModel):
    pages: list[str]           # base64-encoded PNG for each requested page
    page_widths: list[int]     # pixel width of each rendered page
    page_heights: list[int]    # pixel height of each rendered page
    render_offset_x: int = 0   # pixels of left padding (always 0 — no padding added)
    render_offset_y: int = 0   # pixels of top padding (always 0 — no padding added)


class SheetEntry(BaseModel):
    sheet_id: str          # e.g. "A-101"
    sheet_title: str       # e.g. "FIRST FLOOR PLAN"
    pdf_page: int          # 1-indexed page in the PDF
    sheet_type: str        # floor_plan | signage_schedule | sign_details | egress | code_review | other
    level: Optional[str]   # LEVEL 1, LEVEL 2, etc. if detectable


class ParseIndexResponse(BaseModel):
    sheets: list[SheetEntry]
    drawing_index_page: Optional[int]
    total_pages: int = 0


# ---------------------------------------------------------------------------
# Sheet-type detection helpers
# ---------------------------------------------------------------------------

FLOOR_PLAN_KEYWORDS = [
    "floor plan", "floorplan", "construction plan",
    "first floor", "second floor", "third floor",
    "level 1", "level 2", "level 3", "level 4", "level 5",
    "basement plan", "ground floor plan",
    "partial plan", "overall plan",
    "signage plan", "sign plan",
    "partial signage plan", "overall signage plan",
    "plan - level", "plan - area",
    "interior plan", "interior signage",
]

# Hard exclusion keywords — a title containing any of these (forward OR reversed)
# is NEVER a floor plan, regardless of sheet ID prefix.
# Applied BEFORE NON_ARCH_PREFIXES so that e.g. I-001 "FOR GENERAL NOTES AND SYMBOLS"
# is correctly rejected even though I-0xx normally maps to floor_plan.
HARD_TITLE_EXCLUSIONS = [
    "notes", "symbols", "schedule", "specification",
    "cover sheet", "cover page", "index of", "sheet index", "drawing index",
    "elevation", "section", "detail",
]

# Sheets whose titles contain any of these are NEVER classified as floor plans.
FLOOR_PLAN_EXCLUSION_KEYWORDS = [
    "plumbing", "mechanical", "electrical", "hvac",
    "structural", "civil", "landscape", "demolition",
    "reflected ceiling", "foundation", "framing",
    "site plan", "roof plan",
    # Legends, notes, and finish schedules are reference sheets, not floor plans.
    # Checked against both forward and reversed title (see detect_sheet_type).
    "legends", "plan notes", "finish schedule",
    # Parking, garage, and drain sheets are never signage floor plans.
    "parking", "garage", "drain", "basement podium",
]

# Compiled pattern: 3+ consecutive digit characters (room numbers like 1101, 1102).
_ROOM_NUMBER_RE = re.compile(r'\b\d{3,}\b')
# Compiled pattern: IN-series sheet references embedded in a title (e.g. "IN116", "IN-115").
_IN_SERIES_REF_RE = re.compile(r'\bIN-?\d{2,3}\b', re.IGNORECASE)
SIGNAGE_KEYWORDS = [
    # Require explicit schedule/legend to avoid misclassifying "Signage Plan" sheets
    "sign schedule", "signage schedule", "plaque schedule",
    "sign legend", "signage legend", "room identification",
    # Pass 1 (3-pass detection): notes / criteria / spec sheets → signage_schedule
    # (used for sign-dictionary extraction in Step B).
    # "sign type" is intentionally omitted — too broad; "EXIT SIGN TYPE" appears
    # on floor plan notes and would cause false positives.
    "sign notes", "signage notes",     # e.g. "SIGN NOTES", "SIGNAGE NOTES"
    "sign criteria",                   # e.g. "SIGN CRITERIA SHEET"
    "sign spec",                       # e.g. "SIGN SPECIFICATION"
]

# Sheets whose titles contain any of these keywords describe individual sign
# designs/dimensions/materials — they feed specialty-sign extraction (Step 9.2),
# NOT the sign-dictionary (Step B).  Checked BEFORE SIGNAGE_KEYWORDS in Tier 1
# so "SIGNAGE DETAILS" returns sign_details rather than signage_schedule.
SIGN_DETAILS_KEYWORDS = [
    "sign detail", "signage detail",   # e.g. "SIGNAGE DETAILS", "SIGN DETAIL SHEET"
    "sign typ",                        # "SIGN TYPE SHEET", "SIGN TYPES" (note: partial match)
    "signage typ",                     # "SIGNAGE TYPES"
]
EGRESS_KEYWORDS = [
    "egress", "life safety", "means of egress"
]
CODE_KEYWORDS = [
    "code", "zoning", "occupancy", "accessibility"
]

LEVEL_PATTERNS = [
    (re.compile(r"\blevel\s*(\d+)\b", re.IGNORECASE), "LEVEL {}"),
    (re.compile(r"\bbasement\b", re.IGNORECASE), "BASEMENT"),
    (re.compile(r"\bground\s*floor\b", re.IGNORECASE), "GROUND FLOOR"),
    (re.compile(r"\b(1st|first)\s*floor\b", re.IGNORECASE), "LEVEL 1"),
    (re.compile(r"\b(2nd|second)\s*floor\b", re.IGNORECASE), "LEVEL 2"),
    (re.compile(r"\b(3rd|third)\s*floor\b", re.IGNORECASE), "LEVEL 3"),
    (re.compile(r"\bmezzanine\b", re.IGNORECASE), "MEZZANINE"),
    (re.compile(r"\broof\b", re.IGNORECASE), "ROOF"),
]

DRAWING_INDEX_KEYWORDS = [
    "drawing index", "sheet index", "index of drawings", "list of drawings",
    "drawing list", "sheet list"
]

# Broad pattern used when parsing a dedicated drawing-index page (where IDs are
# listed in a table, so false-positives are unlikely).
# Two alternations:
#   1. Standard AIA-style IDs:   A-101, IN116, S3.4A, etc.
#   2. Numeric-dotted IDs:       3.9.51, 10.2.3, etc. (DiNisco and similar firms)
SHEET_ID_PATTERN = re.compile(
    r"\b([A-Z]{1,3}[-]?\d{1,4}(?:\.\d{1,3})?[A-Z]?|\d{1,2}\.\d{1,2}\.\d{1,4})\b"
)

# ---------------------------------------------------------------------------
# Title-block extraction helpers
# ---------------------------------------------------------------------------

def _title_block_words(pg, all_words=None):
    """
    Return words located in the bottom-right quadrant of a page:
      x0  ≥ 70% of page width  (right 30%)
      top ≥ 75% of page height (bottom 25%)
    This is where architectural title blocks live.

    `all_words` lets the caller pass an already-extracted word list so the
    (expensive) pg.extract_words call is performed only once per page.
    """
    pw = pg.width  or 1.0
    ph = pg.height or 1.0
    x_thresh = pw * 0.70
    y_thresh = ph * 0.75
    words = all_words if all_words is not None else (pg.extract_words(x_tolerance=3, y_tolerance=3) or [])
    return [w for w in words
            if w.get("x0", 0) >= x_thresh
            and w.get("top", w.get("y0", 0)) >= y_thresh]


_NUMERIC_DOTTED_RE = re.compile(r'^\d{1,2}\.\d{1,2}\.\d{1,4}$')


def _find_sheet_in_title_block(pg):
    """
    Look for a sheet ID + title in the page's title block.

    Strategy:
    1. Collect words in the bottom-right quadrant (right 30% × bottom 25%).
    2. If a sheet ID is found there, expand to the full bottom band (all x,
       bottom 50%) to assemble lines and locate the drawing title.
       Using 50% instead of 28% to ensure the drawing title — which can sit
       well above the sheet-number line — is included in the band.
    3. For numeric-dotted IDs (DiNisco-style: 3.9.51) prefer the LAST match
       in the title block text, since the sheet number sits at the very
       bottom of the stamp box.  For AIA-style IDs keep the first match.
    4. Return (sheet_id, title) or (None, None).
    """
    pw = pg.width  or 1.0
    ph = pg.height or 1.0

    # Extract page words ONCE and reuse for both the title-block quadrant scan and
    # the bottom-band title scan below — pg.extract_words is the dominant cost in
    # parse-index, and it was previously run twice per page.
    all_words = pg.extract_words(x_tolerance=3, y_tolerance=3) or []

    # --- Step 1: find sheet ID in bottom-right corner ---
    br_words = _title_block_words(pg, all_words)
    if not br_words:
        return None, None

    br_sorted = sorted(br_words, key=lambda w: (w.get("top", w.get("y0", 0)), w.get("x0", 0)))
    br_text = " ".join(w["text"] for w in br_sorted)

    all_matches = list(SHEET_ID_PATTERN.finditer(br_text))
    if not all_matches:
        return None, None

    # Prefer the LAST numeric-dotted match (sheet stamp is at bottom of block).
    # Fall back to the first AIA-style match if no numeric-dotted IDs found.
    numeric_matches = [m for m in all_matches if _NUMERIC_DOTTED_RE.match(m.group(1))]
    m = numeric_matches[-1] if numeric_matches else all_matches[0]

    sheet_id = m.group(1).upper()

    # --- Step 2: collect words in bottom 50% of page, right 50% of width ---
    # 50% height ensures the drawing title (which often sits above the sheet
    # number in non-standard title blocks) is included in the search band.
    # Right-half x-restriction (≥50%) avoids reading text from the sign-legend
    # area that many firms (e.g. DiNisco) place in the bottom-left quadrant.
    # Those legends contain text like "TOILET ROOM SIGN 9"×9"" which would
    # otherwise be mistaken for the drawing title.
    y_band = ph * 0.50
    x_title_thresh = pw * 0.50   # right half only
    band_words = [w for w in all_words
                  if w.get("top", w.get("y0", 0)) >= y_band
                  and w.get("x0", 0) >= x_title_thresh]
    band_sorted = sorted(band_words, key=lambda w: (w.get("top", w.get("y0", 0)), w.get("x0", 0)))

    # Group band words into logical lines (words within 6 pt of each other)
    lines: list[list[str]] = []
    line_tops: list[float] = []
    for w in band_sorted:
        top = w.get("top", w.get("y0", 0))
        if lines and abs(top - line_tops[-1]) < 6:
            lines[-1].append(w["text"])
        else:
            lines.append([w["text"]])
            line_tops.append(top)
    line_texts = [" ".join(ws) for ws in lines]

    # Find which line contains the sheet ID
    sheet_line_idx = None
    for i, lt in enumerate(line_texts):
        if sheet_id in lt.upper():
            sheet_line_idx = i
            break

    title = None
    _SCALE_OR_DATE_RE = re.compile(r'^[\d/\'"=:. -]+$')

    def _is_meaningful_title(s: str) -> bool:
        """True if s looks like a real drawing title (not a stub like 'L C')."""
        if len(s) < 3:
            return False
        words = s.split()
        # Reject lines that are entirely made up of single-character tokens
        # (e.g. abbreviation fragments like "L C" or "R R").
        if words and all(len(w) == 1 for w in words):
            return False
        return True

    if sheet_line_idx is not None:
        # Prefer a line BEFORE the sheet-number line as the drawing title.
        for candidate in reversed(line_texts[:sheet_line_idx]):
            s = candidate.strip(" -.|")
            if (s
                    and not _SCALE_OR_DATE_RE.match(s)
                    and not SHEET_ID_PATTERN.fullmatch(s.strip())
                    and _is_meaningful_title(s)):
                title = s
                break
        # Fall back to a line AFTER the sheet-number line.
        if not title:
            for candidate in line_texts[sheet_line_idx + 1:]:
                s = candidate.strip(" -.|")
                if (s
                        and not _SCALE_OR_DATE_RE.match(s)
                        and not SHEET_ID_PATTERN.fullmatch(s.strip())
                        and _is_meaningful_title(s)):
                    title = s
                    break

    if not title or len(title) < 2:
        title = sheet_id
    if len(title) > 80:
        title = title[:80].rsplit(" ", 1)[0]

    return sheet_id, title.upper()


def detect_sheet_type(sheet_id: str, title: str) -> str:
    title_lower = title.lower()
    sid = sheet_id.lower()

    # Some title blocks are printed rotated 180° — pdfplumber reads characters
    # in reverse order (e.g. "SCHEDULE" becomes "ELUDEHCS"). Check both directions.
    title_rev = title_lower[::-1]

    def in_title(keywords):
        return any(k in title_lower for k in keywords) or any(k in title_rev for k in keywords)

    # ── Tier 1: Explicit title keywords (always win regardless of sheet ID) ──
    # Check sign_details BEFORE signage_schedule — "SIGNAGE DETAILS" must route to
    # sign_details (specialty extraction in Step 9.2), not signage_schedule (Step B
    # sign-dictionary extraction).
    if in_title(SIGN_DETAILS_KEYWORDS):
        return "sign_details"
    if in_title(SIGNAGE_KEYWORDS):
        return "signage_schedule"
    if in_title(EGRESS_KEYWORDS) or "evacuation" in title_lower or "evacuation" in title_rev:
        return "egress"

    # ── Tier 2: Strict A-series sheet-ID rules (standard AIA numbering) ──────
    #   A-003      → egress (occupant loads / means of egress sheet)
    #   A-7XX      → signage_schedule (millwork/specialties; sign/plaque schedules)
    #   A-1XX      → floor_plan (floor plans, level plans)
    #   A-2XX      → floor_plan (floor plans, reflected ceiling plans)
    #   A-3XX      → floor_plan (floor plans at upper levels)
    #   A-4XX      → interior_elevation (mounting heights; rasterized for reference, not sign-extracted)
    #   Everything else (A-0XX notes, A-5XX details, A-6XX RCPs, A-8XX+) → other
    if re.match(r'^a-?003$', sid):
        return "egress"
    if re.match(r'^a-?7\d{2}', sid):
        return "signage_schedule"
    if re.match(r'^a-?[123]\d{2}', sid):
        return "floor_plan"
    if re.match(r'^a-?4\d{2}', sid):
        return "interior_elevation"
    if sid.startswith("a-") or re.match(r'^a\d', sid):
        return "other"

    # ── Tier 2.5: Numeric-dotted IDs (DiNisco and similar firms) ────────────
    # e.g. 3.9.51 – 3.9.56.  No letter prefix → none of the AIA rules above
    # apply.
    # Pass 1 (3-pass detection): signage-document keywords take priority over
    # generic hard-exclusion rules so "SIGNAGE DETAILS" returns sign_details
    # and "SIGN SCHEDULE" returns signage_schedule rather than falling through
    # to "other" via the "detail" exclusion in HARD_TITLE_EXCLUSIONS.
    if _NUMERIC_DOTTED_RE.match(sid):
        if in_title(SIGN_DETAILS_KEYWORDS):
            return "sign_details"
        if in_title(SIGNAGE_KEYWORDS):
            return "signage_schedule"
        if in_title(HARD_TITLE_EXCLUSIONS) or in_title(FLOOR_PLAN_EXCLUSION_KEYWORDS):
            return "other"
        return "floor_plan"

    # ── Tier 3: I-series / IN-series (government / SOF interior signage) ─────
    #   I-6XX+  → signage_schedule (reversed-text "ELUDEHCS" titles handled by Tier 1)
    #   I-0XX–I-5XX → floor_plan (interior signage floor plan sheets)
    #   IN-XXX  → floor_plan
    i_match = re.match(r'^i-(\d)', sid)
    if i_match:
        return "signage_schedule" if int(i_match.group(1)) >= 6 else "floor_plan"
    if re.match(r'^in-?\d{2,3}', sid):
        return "floor_plan"

    # S-series with an IN-series reference in the title → SOF interior plan sheet
    # (e.g. S121 titled "…IN116 S21 BB2B 337TH ADMIN…")
    if sid.startswith("s") and _IN_SERIES_REF_RE.search(title):
        return "floor_plan"

    # ── Tier 4: Discipline-prefix rejection (skip entirely) ───────────────────
    #   P=plumbing, M=mechanical, E=electrical, S=structural, C=civil,
    #   L=landscape, FD/FP=fire, D=demo/detail, T=title/telecom,
    #   G=general notes, NR/N=non-standard notes
    _SKIP_PREFIXES = (
        "p-", "p0", "p1", "p2",
        "m-", "m0", "m1", "m2",
        "e-", "e0", "e1", "e2",
        "s-", "s0", "s1", "s2", "s3",
        "c-", "c0", "c1",
        "l-", "l0", "l1",
        "fd-", "fp-",
        "d-", "d0", "d1", "d2",
        "t-", "t0", "t1",
        "g-", "g0", "g1",
        "nr-", "n-",
    )
    if sid.startswith(_SKIP_PREFIXES):
        return "other"

    # ── Tier 5: Hard title exclusions (fallback for non-standard sheet IDs) ──
    if in_title(HARD_TITLE_EXCLUSIONS) or in_title(FLOOR_PLAN_EXCLUSION_KEYWORDS):
        return "other"

    # ── Tier 6: Title-based floor plan detection (last resort) ────────────────
    if in_title(FLOOR_PLAN_KEYWORDS):
        return "floor_plan"

    return "other"


def detect_level(title: str) -> Optional[str]:
    for pattern, template in LEVEL_PATTERNS:
        m = pattern.search(title)
        if m:
            if m.lastindex and m.lastindex >= 1:
                try:
                    return template.format(m.group(1))
                except (IndexError, KeyError):
                    return template
            return template
    return None


# ---------------------------------------------------------------------------
# Room-tag extraction helpers (char stream + pts_to_pixels)
# ---------------------------------------------------------------------------

# Sign-code pattern: 1–4 uppercase letters, a literal dash, then 2–3 digits.
# Examples that match:   RM-101  SR-204  D-103  EGRS-105  EL-201
# Examples that reject:  CPT-1  VCT-2  PT-3 (single digit after dash)
#                        101  1212A (no letters before dash)
#                        TYP  SIM  A (no dash at all)
#                        3'-4"  12.5 (dimension strings)
_ROOM_TAG_PATTERNS = [
    re.compile(r'^[A-Z]{1,4}-\d{2,3}$'),
]

_IGNORE_WORDS = {
    "THE", "AND", "OR", "OF", "A", "AN", "IN", "AT", "BY", "FOR",
    "N", "S", "E", "W", "NE", "NW", "SE", "SW",
    "FT", "SF", "SQ", "FF", "EQ", "TYP", "SIM", "REF",
}


def extract_room_tags_from_chars(plumber_page, room_patterns=None):
    """
    Scan pdfplumber character stream for room tags.
    Works when PDF stores tags as individual chars (most modern architectural PDFs).
    Falls back to extract_words() for older PDFs if char scan yields nothing.
    """
    if room_patterns is None:
        room_patterns = _ROOM_TAG_PATTERNS

    bbox = plumber_page.bbox
    bbox_x0, bbox_y0 = float(bbox[0]), float(bbox[1])
    pw = float(plumber_page.width)
    ph = float(plumber_page.height)

    chars = plumber_page.chars
    found = []
    seen_tags = set()
    i = 0

    while i < len(chars):
        matched = False
        for length in [6, 5, 4, 3, 2]:
            if i + length > len(chars):
                continue
            segment = chars[i:i + length]
            text = ''.join(c['text'] for c in segment).strip()
            if not text or text in seen_tags:
                if text in seen_tags and length == 2:
                    break
                continue
            for pattern in room_patterns:
                if pattern.match(text):
                    c0, ce = segment[0], segment[-1]
                    cx = (float(c0['x0']) + float(ce['x1'])) / 2
                    cy = (float(c0['top']) + float(c0['bottom'])) / 2
                    found.append({
                        'tag': text,
                        'x_pts': cx,
                        'y_pts': cy,
                        'bbox_x0': bbox_x0,
                        'bbox_y0': bbox_y0,
                        'page_w': pw,
                        'page_h': ph,
                    })
                    seen_tags.add(text)
                    matched = True
                    i += length
                    break
            if matched:
                break
        if not matched:
            i += 1

    # Fallback: if char scan found nothing, try extract_words
    if not found:
        words = plumber_page.extract_words(x_tolerance=3, y_tolerance=3)
        for w in words:
            text = w['text'].strip()
            if text in seen_tags:
                continue
            for pattern in room_patterns:
                if pattern.match(text):
                    cx = (float(w['x0']) + float(w['x1'])) / 2
                    cy = (float(w['top']) + float(w['bottom'])) / 2
                    found.append({
                        'tag': text,
                        'x_pts': cx,
                        'y_pts': cy,
                        'bbox_x0': bbox_x0,
                        'bbox_y0': bbox_y0,
                        'page_w': pw,
                        'page_h': ph,
                    })
                    seen_tags.add(text)
                    break

    return found


def pts_to_pixels(x_pts, y_pts, bbox_x0, bbox_y0, page_w, page_h, img_w, img_h):
    """
    Convert PDF point coordinates to raster image pixel coordinates.
    MUST use bbox offset — PDF mediabox origin is often not (0,0).
    """
    if page_w == 0 or page_h == 0:
        return 0, 0
    px = int((x_pts - bbox_x0) * (img_w / page_w))
    py = int((y_pts - bbox_y0) * (img_h / page_h))
    px = max(0, min(px, img_w - 1))
    py = max(0, min(py, img_h - 1))
    return px, py


# ---------------------------------------------------------------------------
# /extract-room-tags
# ---------------------------------------------------------------------------

class RoomTag(BaseModel):
    room_number: str
    room_name: str
    x_pts: float
    y_pts: float
    bbox_x0: float
    bbox_y0: float
    page_w: float
    page_h: float


class ExtractRoomTagsResponse(BaseModel):
    room_tags: list[RoomTag]
    page_width: float
    page_height: float
    bbox_x0: float
    bbox_y0: float


@app.post("/extract-room-tags", response_model=ExtractRoomTagsResponse)
def extract_room_tags_endpoint(
    file: UploadFile = File(...),
    page: int = Form(1),
):
    """
    Extract room tags from a floor plan PDF page using character stream scanning.
    Also harvests nearby words for room names.

    Sync `def` → runs in Starlette's threadpool; the semaphore caps concurrent
    heavy parsing so memory stays bounded.
    """
    try:
        raw = file.file.read()
        with _work_sem, pdfplumber.open(io.BytesIO(raw)) as pdf:
            if page < 1 or page > len(pdf.pages):
                raise HTTPException(
                    status_code=400,
                    detail=f"Page {page} out of range (PDF has {len(pdf.pages)} pages)"
                )
            pg = pdf.pages[page - 1]
            bbox = pg.bbox
            bbox_x0, bbox_y0 = float(bbox[0]), float(bbox[1])
            pw, ph = float(pg.width), float(pg.height)

            # Extract room tags via char stream
            tags = extract_room_tags_from_chars(pg)

            # Exclusion zones (fractions of page dimensions):
            #   bottom 18% — legend box, north arrow, scale bar, sheet notes
            #   right 20%  — title block, firm logos, revision table, stamp
            legend_x_thresh = pw * 0.80  # right 20%
            legend_y_thresh = ph * 0.90  # bottom 10%

            # Sign type code pattern — tokens that indicate an Interior Signage
            # Legend cluster rather than a room label.
            _SIGN_CODE_RE = re.compile(
                r'^(MB|TB|CB|SA|SB|SC|SD|19[A-Z]|\d+[AB]?)$', re.IGNORECASE
            )

            # Extract all words then split into zone-clean and zone-dirty sets.
            raw_all_words = pg.extract_words(x_tolerance=3, y_tolerance=3) or []
            excluded_count = 0
            all_words = []
            for _w in raw_all_words:
                _wx = (float(_w['x0']) + float(_w['x1'])) / 2
                _wy = (float(_w['top']) + float(_w['bottom'])) / 2
                if _wy > legend_y_thresh or _wx > legend_x_thresh:
                    excluded_count += 1
                else:
                    all_words.append(_w)

            # Secondary cluster filter: words where >30% of close neighbours are
            # sign type codes (Interior Signage Legend box remnants).
            def _in_sign_code_cluster(wx, wy, word_list):
                cluster = [
                    _w2 for _w2 in word_list
                    if abs((float(_w2['x0']) + float(_w2['x1'])) / 2 - wx) < 120
                    and abs((float(_w2['top']) + float(_w2['bottom'])) / 2 - wy) < 40
                ]
                if len(cluster) < 3:
                    return False
                code_count = sum(1 for _w2 in cluster if _SIGN_CODE_RE.match(_w2['text'].strip()))
                return code_count / len(cluster) > 0.30

            clean_words = [
                _w for _w in all_words
                if not _in_sign_code_cluster(
                    (float(_w['x0']) + float(_w['x1'])) / 2,
                    (float(_w['top']) + float(_w['bottom'])) / 2,
                    all_words,
                )
            ]
            cluster_excluded = len(all_words) - len(clean_words)
            excluded_count += cluster_excluded

            print(
                f"Page {page}: excluded {excluded_count} words in legend/title zones "
                f"({cluster_excluded} sign-code cluster), "
                f"retained {len(clean_words)} words for room extraction"
            )

            result_tags = []
            for t in tags:
                tx, ty = t['x_pts'], t['y_pts']
                # Skip tags inside exclusion zones
                if tx > legend_x_thresh or ty > legend_y_thresh:
                    continue

                # Gather nearby words for room name (from clean word list only)
                nearby = []
                for w in clean_words:
                    wx = (float(w['x0']) + float(w['x1'])) / 2
                    wy = (float(w['top']) + float(w['bottom'])) / 2
                    dx = abs(wx - tx)
                    dy = abs(wy - ty)
                    tight_cluster = dy < 40 and dx < 80
                    same_line_close = dy < 15 and dx < 200
                    if not (tight_cluster or same_line_close):
                        continue
                    wtext = w['text'].strip()
                    wupper = wtext.upper()
                    # Skip the tag itself, ignore words, grid refs, small ints
                    if wupper == t['tag']:
                        continue
                    if wupper in _IGNORE_WORDS:
                        continue
                    if len(wupper) == 1 and wupper.isalpha():
                        continue  # single-letter grid refs
                    if re.match(r'^\d+\.\d+$', wtext):
                        continue  # decimal grid axis labels
                    if re.match(r'^\d+$', wtext) and len(wtext) <= 2:
                        continue  # small integers
                    if len(wtext) > 30:
                        continue
                    if re.match(r"^\d+['\"\-\/]", wtext):
                        continue  # dimension annotations
                    nearby.append((float(w['x0']), wupper))

                nearby.sort(key=lambda n: n[0])
                raw_name = ' '.join(n[1] for n in nearby[:5]).strip()

                # Reject address-like or copyright noise
                if (',' in raw_name or
                        re.search(r'\b(AVE|BLVD|ST\b|RD\b|DR\b|MA\b|NY\b|CA\b|COPYRIGHT|DRAWING|PROJECT)\b', raw_name)):
                    raw_name = ''

                if not raw_name:
                    is_residential = bool(re.match(r'^\d{3}[A-Z]?$', t['tag']))
                    raw_name = f"UNIT {t['tag']}" if is_residential else f"ROOM {t['tag']}"

                result_tags.append(RoomTag(
                    room_number=t['tag'],
                    room_name=raw_name,
                    x_pts=tx,
                    y_pts=ty,
                    bbox_x0=bbox_x0,
                    bbox_y0=bbox_y0,
                    page_w=pw,
                    page_h=ph,
                ))

            return ExtractRoomTagsResponse(
                room_tags=result_tags,
                page_width=pw,
                page_height=ph,
                bbox_x0=bbox_x0,
                bbox_y0=bbox_y0,
            )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail=f"extract-room-tags error: {traceback.format_exc()}")


# ---------------------------------------------------------------------------
# /extract-words
# ---------------------------------------------------------------------------

@app.post("/extract-words", response_model=ExtractWordsResponse)
def extract_words(
    file: UploadFile = File(...),
    page: int = Form(1),
):
    """Extract words with bounding boxes from a single PDF page (1-indexed)."""
    try:
        raw = file.file.read()
        with _work_sem, pdfplumber.open(io.BytesIO(raw)) as pdf:
            if page < 1 or page > len(pdf.pages):
                raise HTTPException(
                    status_code=400,
                    detail=f"Page {page} out of range (PDF has {len(pdf.pages)} pages)"
                )
            pg = pdf.pages[page - 1]
            raw_words = pg.extract_words(
                x_tolerance=3,
                y_tolerance=3,
                keep_blank_chars=False,
                use_text_flow=False,
            )
            words = [
                Word(
                    text=w["text"],
                    x0=w["x0"],
                    y0=w["top"],
                    x1=w["x1"],
                    y1=w["bottom"],
                    page=page,
                )
                for w in raw_words
            ]
            return ExtractWordsResponse(
                words=words,
                page_width=float(pg.width),
                page_height=float(pg.height),
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"extract-words error: {traceback.format_exc()}")


# ---------------------------------------------------------------------------
# /extract-table
# ---------------------------------------------------------------------------

class ExtractTableResponse(BaseModel):
    tables: list[list[list[str]]]  # tables[tableIdx][rowIdx][colIdx]
    page: int
    table_count: int


def _extract_tables_worker(raw: bytes, page: int, strategy: str, max_chars: int, q) -> None:
    """Child-process body for table extraction.

    Runs in a separate process so the parent can hard-kill it on deadline —
    pdfplumber's table finder is pure-Python and otherwise uncancellable. Pushes
    one of ("ok", tables) / ("skip", []) / ("err", message) onto `q`.
    """
    try:
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            pg = pdf.pages[page - 1]
            # Dense-page guard (speculative "text" scans only): a huge drawing has
            # thousands of words, which makes text-based table detection explode.
            # Such sheets are floor plans, not schedules — skip the expensive find.
            if strategy == "text" and max_chars > 0 and len(pg.chars) > max_chars:
                q.put(("skip", []))
                return
            if strategy == "text":
                raw_tables = pg.extract_tables(
                    table_settings={
                        "vertical_strategy": "text",
                        "horizontal_strategy": "text",
                    }
                ) or []
            else:
                raw_tables = pg.extract_tables() or []
            tables = [
                [[str(cell) if cell is not None else "" for cell in row] for row in table]
                for table in raw_tables
            ]
        q.put(("ok", tables))
    except Exception as exc:  # surfaced to the parent, which raises a 500
        q.put(("err", repr(exc)))


def _extract_tables_with_deadline(
    raw: bytes, page: int, strategy: str, deadline_s: float, max_chars: int
) -> list:
    """Run table extraction in a killable child process bounded by `deadline_s`.

    Returns the normalized tables, or [] if the page was skipped as too dense or
    the deadline fired (the child is terminated, so its CPU is freed instead of
    grinding on after the caller has given up).
    """
    q: "mp.Queue" = mp.Queue()
    proc = mp.Process(
        target=_extract_tables_worker, args=(raw, page, strategy, max_chars, q)
    )
    proc.start()
    try:
        status, payload = q.get(timeout=deadline_s)
    except _queue.Empty:
        proc.terminate()
        proc.join(5)
        print(
            f"[extract-table] deadline {deadline_s}s exceeded on page {page} "
            f"(strategy={strategy}) — terminated, returning 0 tables"
        )
        return []
    finally:
        q.cancel_join_thread()
        q.close()

    proc.join(5)
    if proc.is_alive():
        proc.terminate()
    if status == "err":
        raise RuntimeError(f"extract_tables worker failed: {payload}")
    if status == "skip":
        print(
            f"[extract-table] page {page} skipped as too dense "
            f"(>{max_chars} chars, strategy={strategy}) — returning 0 tables"
        )
    return payload


@app.post("/extract-table", response_model=ExtractTableResponse)
def extract_table(
    file: UploadFile = File(...),
    page: int = Form(1),
    strategy: str = Form("lines"),
):
    """Extract tabular data from a single PDF page using pdfplumber.
    Returns all tables found on the page with cells normalized to strings.

    `strategy` selects pdfplumber's table-detection method:
      * "lines" (default) — line-based detection. Best for dedicated, ruled
        schedule sheets. Pathologically slow on vector-dense floor plans, where
        thousands of wall/grid/dimension strokes blow up the intersection search.
      * "text" — derive the grid from word alignment, ignoring vector lines
        entirely. Use for speculative scans of floor-plan sheets.

    The extraction runs under a hard wall-clock deadline in a child process
    (SIDECAR_TABLE_DEADLINE_S) and dense "text"-scan pages are skipped outright
    (SIDECAR_TABLE_MAX_CHARS), so a dense drawing can never pin the container.
    """
    try:
        raw = file.file.read()
        # Cheap page-count validation (structure only — no content parse). The
        # expensive content parse + table find happens in the killable child.
        with pdfplumber.open(io.BytesIO(raw)) as pdf:
            npages = len(pdf.pages)
        if page < 1 or page > npages:
            raise HTTPException(
                status_code=400,
                detail=f"Page {page} out of range (PDF has {npages} pages)"
            )
        with _work_sem:
            tables = _extract_tables_with_deadline(
                raw, page, strategy, SIDECAR_TABLE_DEADLINE_S, SIDECAR_TABLE_MAX_CHARS
            )
        return ExtractTableResponse(
            tables=tables,
            page=page,
            table_count=len(tables),
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail=f"extract-table error: {traceback.format_exc()}")


# ---------------------------------------------------------------------------
# /rasterize
# ---------------------------------------------------------------------------

@app.post("/rasterize", response_model=RasterizeResponse)
def rasterize(
    file: UploadFile = File(...),
    pages: str = Form("1"),   # comma-separated 1-indexed page numbers
    dpi: int = Form(150),
):
    """Rasterize one or more PDF pages to PNG, returned as base64.

    Each (page, dpi) render is cached by the PDF's content hash, so a page that
    is rasterized again in a later step or request is served from memory rather
    than re-spawning poppler. Cache misses render under the concurrency cap.
    """
    try:
        raw = file.file.read()
        page_list = [int(p.strip()) for p in pages.split(",") if p.strip()]
        if not page_list:
            raise HTTPException(status_code=400, detail="pages must be non-empty")

        h = _pdf_hash(raw)
        keys = {p: f"{h}|raster|{p}|{dpi}" for p in set(page_list)}

        # rendered[page] = (base64, width, height)
        rendered: dict[int, tuple[str, int, int]] = {}
        misses: list[int] = []
        for p in page_list:
            if p in rendered or p in misses:
                continue  # de-dupe repeated pages within one request
            hit = _cache_get(keys[p])
            if hit is not None:
                rendered[p] = hit
            else:
                misses.append(p)

        if misses:
            with _work_sem:
                for page_num in misses:
                    images = convert_from_bytes(
                        raw,
                        dpi=dpi,
                        first_page=page_num,
                        last_page=page_num,
                        fmt="PNG",
                    )
                    if not images:
                        raise HTTPException(status_code=500, detail=f"Failed to rasterize page {page_num}")
                    img = images[0]
                    w, ht = img.size  # exact pixel dimensions of the rendered PNG
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    b64 = base64.b64encode(buf.getvalue()).decode()
                    rendered[page_num] = (b64, w, ht)
                    _cache_put(keys[page_num], (b64, w, ht), len(b64))

        results = [rendered[p][0] for p in page_list]
        widths = [rendered[p][1] for p in page_list]
        heights = [rendered[p][2] for p in page_list]
        return RasterizeResponse(pages=results, page_widths=widths, page_heights=heights)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"rasterize error: {traceback.format_exc()}")


# ---------------------------------------------------------------------------
# /parse-index
# ---------------------------------------------------------------------------

@app.post("/parse-index", response_model=ParseIndexResponse)
def parse_index(file: UploadFile = File(...)):
    """
    Parse a drawing index from a PDF.
    Scans every page, tries to find a drawing index page, extracts sheet IDs+titles.
    Falls back to per-page heuristic if no explicit index found.
    """
    try:
        raw = file.file.read()
        with _work_sem, pdfplumber.open(io.BytesIO(raw)) as pdf:
            sheets: list[SheetEntry] = []
            drawing_index_page: Optional[int] = None

            # --- First pass: look for a drawing index page ---
            index_page_num: Optional[int] = None
            for i, pg in enumerate(pdf.pages):
                text = (pg.extract_text() or "").lower()
                if any(k in text for k in DRAWING_INDEX_KEYWORDS):
                    index_page_num = i + 1
                    break

            if index_page_num is not None:
                drawing_index_page = index_page_num
                pg = pdf.pages[index_page_num - 1]
                text = pg.extract_text() or ""
                sheets = _parse_index_text(text, index_page_num, len(pdf.pages), pdf)

            # --- If no index found (or empty result), scan all pages ---
            if not sheets:
                sheets = _scan_all_pages(pdf)

            total_pages = len(pdf.pages)
            print(
                f"[parse-index] SUMMARY: {len(sheets)} sheets found "
                f"(drawing_index_page={drawing_index_page}, total_pages={total_pages}): "
                + ", ".join(f"{s.sheet_id}(p{s.pdf_page})" for s in sheets)
            )
            return ParseIndexResponse(
                sheets=sheets,
                drawing_index_page=drawing_index_page,
                total_pages=total_pages,
            )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"parse-index error: {traceback.format_exc()}")


def _parse_index_text(text: str, index_page: int, total_pages: int, pdf) -> list[SheetEntry]:
    """
    Parse sheet entries from a drawing index page text.

    Strategy:
    1. Extract sheet IDs + titles from the index page text.
    2. For each sheet ID found, scan the remaining PDF pages to find which page
       actually has that sheet ID in its title block. This gives an accurate pdf_page.
    3. Fall back to sequential estimation only when scanning fails.
    """
    sheets = []
    seen_ids: set[str] = set()
    lines = text.splitlines()

    # Step 1: Build preliminary list from index text
    prelim: list[dict] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        m = SHEET_ID_PATTERN.search(line)
        if not m:
            continue
        sheet_id = m.group(1).upper()
        if sheet_id in seen_ids:
            continue
        seen_ids.add(sheet_id)

        title_part = line[m.end():].strip(" -.|")
        if not title_part:
            title_part = line[:m.start()].strip(" -.|")
        if not title_part:
            title_part = sheet_id

        prelim.append({"sheet_id": sheet_id, "title": title_part.upper()})

    if not prelim:
        return []

    # Step 2: Scan pages to find which PDF page each sheet ID lives on.
    # Strategy: check the title block (bottom-right quadrant) of each page, where
    # the sheet number is reliably printed in architectural drawings.  This avoids
    # the old bug where "first N words" returned room-number text from the plan body.
    sheet_to_page: dict[str, int] = {}
    try:
        # Reuse the pdfplumber object already opened by parse_index instead of
        # re-parsing the whole file a second time within one request.
        for page_i, pg in enumerate(pdf.pages):
            if page_i + 1 == index_page:
                continue  # skip the index page itself

            # Primary: look in the bottom-right title block
            found_id, _ = _find_sheet_in_title_block(pg)
            if found_id and found_id in {e["sheet_id"] for e in prelim}:
                if found_id not in sheet_to_page:
                    sheet_to_page[found_id] = page_i + 1
                continue

            # Fallback: check full page text for any known sheet ID
            words = pg.extract_words(x_tolerance=3, y_tolerance=3) or []
            full_text = " ".join(w["text"] for w in words).upper()
            for entry in prelim:
                sid = entry["sheet_id"]
                if sid not in sheet_to_page and re.search(
                    r'(?<![A-Z0-9])' + re.escape(sid) + r'(?![A-Z0-9])', full_text
                ):
                    sheet_to_page[sid] = page_i + 1
    except Exception:
        pass  # fall back to sequential estimation below

    # Step 3: Build final sheet list with best-known page numbers
    for i, entry in enumerate(prelim):
        sheet_id = entry["sheet_id"]
        title_part = entry["title"]

        # Use scanned page if found; otherwise estimate sequentially from index page
        if sheet_id in sheet_to_page:
            pdf_page = sheet_to_page[sheet_id]
            page_src = "scanned"
        else:
            # Sequential estimate: pages after the index page, in order
            pdf_page = min(index_page + i + 1, total_pages)
            page_src = "estimated"

        sheet_type = detect_sheet_type(sheet_id, title_part)
        level = detect_level(title_part)

        print(
            f"[parse-index] index→ sheet_id={sheet_id!r} "
            f"title={title_part!r} type={sheet_type} page={pdf_page} ({page_src})"
        )

        sheets.append(SheetEntry(
            sheet_id=sheet_id,
            sheet_title=title_part,
            pdf_page=pdf_page,
            sheet_type=sheet_type,
            level=level,
        ))

    return sheets


def _scan_all_pages(pdf) -> list[SheetEntry]:
    """
    Scan every PDF page and extract the sheet ID+title from its title block.

    Primary strategy: bottom-right quadrant extraction via _find_sheet_in_title_block.
    This avoids reading room-number text from the plan body that appears in the
    first N words of each page (old approach was the source of the garbage output).

    Fallback: full page text scan for pages where the title block is rotated,
    compressed, or otherwise inaccessible from the bottom-right region.
    """
    sheets = []
    seen_ids: set[str] = set()

    for i, pg in enumerate(pdf.pages):
        page_num = i + 1

        # --- Primary: title block (bottom-right) ---
        sheet_id, title_part = _find_sheet_in_title_block(pg)

        if sheet_id:
            source = "title_block"
        else:
            # --- Fallback: full page text ---
            full = pg.extract_text() or ""
            m = SHEET_ID_PATTERN.search(full)
            if not m:
                print(f"[parse-index] Page {page_num}: no sheet ID found (title_block=None, full_text=None)")
                continue
            sheet_id = m.group(1).upper()
            title_part = full[m.end():m.end() + 120].strip()
            title_part = re.split(r"[|\n\r]", title_part)[0].strip(" -.")
            if not title_part:
                title_part = sheet_id
            if len(title_part) > 80:
                title_part = title_part[:80].rsplit(" ", 1)[0]
            title_part = title_part.upper()
            source = "full_text_fallback"

        if sheet_id in seen_ids:
            continue
        seen_ids.add(sheet_id)

        sheet_type = detect_sheet_type(sheet_id, title_part)
        level = detect_level(title_part)

        print(
            f"[parse-index] Page {page_num}: sheet_id={sheet_id!r} "
            f"title={title_part!r} type={sheet_type} source={source}"
        )

        sheets.append(SheetEntry(
            sheet_id=sheet_id,
            sheet_title=title_part,
            pdf_page=page_num,
            sheet_type=sheet_type,
            level=level,
        ))

    return sheets


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# /rasterize-tiles
# ---------------------------------------------------------------------------

class TileResult(BaseModel):
    base64: str
    offset_x: float
    offset_y: float
    scale_x: float
    scale_y: float
    col: int
    row: int


class RasterTilesResponse(BaseModel):
    tiles: list[TileResult]
    width: int
    height: int
    full_page: str = ""        # base64 PNG of the whole page at full_dpi (reused
                               # by callers for thumbnails / downstream text reads,
                               # so the page is rasterized only once)


@app.post("/rasterize-tiles", response_model=RasterTilesResponse)
def rasterize_tiles(
    file: UploadFile = File(...),
    page: int = Form(1),
    dpi: int = Form(100),
    full_dpi: int = Form(0),
):
    """Rasterize one PDF page ONCE and return both a 2×2 grid of overlapping tiles
    AND the full page, so callers never have to render the same page twice.

    The page is rendered at `render_dpi = max(dpi, full_dpi)`. The returned
    `full_page` is at that resolution (use full_dpi=150 to keep it crisp for
    downstream schedule/occupant text reading). Tiles are downscaled back to
    `dpi`-equivalent pixels so their token size stays small — tile offset/scale
    are page fractions, so the downscale does not affect coordinate math.

    Cached by the PDF's content hash + (page, dpi, render_dpi).
    """
    try:
        pdf_bytes = file.file.read()
        render_dpi = max(dpi, full_dpi) if full_dpi else dpi
        cache_key = f"{_pdf_hash(pdf_bytes)}|tiles|{page}|{dpi}|{render_dpi}"
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached

        with _work_sem:
            images = convert_from_bytes(
                pdf_bytes,
                dpi=render_dpi,
                first_page=page,
                last_page=page,
                fmt="PNG",
            )
            if not images:
                raise HTTPException(status_code=500, detail=f"Failed to rasterize page {page}")

            img = images[0]
            w, h = img.size

            # Full page at render_dpi — encoded once, reused by the caller.
            full_buf = io.BytesIO()
            img.save(full_buf, format="PNG")
            full_page_b64 = base64.b64encode(full_buf.getvalue()).decode()

            # Tiles are downscaled to `dpi`-equivalent pixels to keep them small.
            tile_scale = (dpi / render_dpi) if render_dpi else 1.0

            # 2×2 grid with 10% overlap on each edge
            overlap_x = int(w * 0.05)
            overlap_y = int(h * 0.05)

            tiles: list[TileResult] = []
            for row in range(2):
                for col in range(2):
                    x1 = max(0, col * w // 2 - overlap_x)
                    y1 = max(0, row * h // 2 - overlap_y)
                    x2 = min(w, (col + 1) * w // 2 + overlap_x)
                    y2 = min(h, (row + 1) * h // 2 + overlap_y)

                    tile_img = img.crop((x1, y1, x2, y2))
                    if tile_scale < 1.0:
                        tw = max(1, int((x2 - x1) * tile_scale))
                        th = max(1, int((y2 - y1) * tile_scale))
                        tile_img = tile_img.resize((tw, th), _PILImage.LANCZOS)
                    buf = io.BytesIO()
                    tile_img.save(buf, format="PNG")

                    tiles.append(TileResult(
                        base64=base64.b64encode(buf.getvalue()).decode(),
                        offset_x=x1 / w,
                        offset_y=y1 / h,
                        scale_x=(x2 - x1) / w,
                        scale_y=(y2 - y1) / h,
                        col=col,
                        row=row,
                    ))

        response = RasterTilesResponse(tiles=tiles, width=w, height=h, full_page=full_page_b64)
        _cache_put(
            cache_key,
            response,
            len(response.full_page) + sum(len(t.base64) for t in response.tiles),
        )
        return response
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=500, detail=f"rasterize-tiles error: {traceback.format_exc()}")


@app.post("/extract-text-positions")
def extract_text_positions(
    file: UploadFile = File(...),
    page_number: int = Form(1)
):
    data = file.file.read()
    try:
        with _work_sem, pdfplumber.open(io.BytesIO(data)) as pdf:
            if page_number > len(pdf.pages):
                return {"words": [], "searchable": False}

            page = pdf.pages[page_number - 1]
            words = page.extract_words(
                x_tolerance=3,
                y_tolerance=3,
                keep_blank_chars=False,
                use_text_flow=False
            )

            if not words:
                return {"words": [], "searchable": False}

            page_width = float(page.width)
            page_height = float(page.height)

            return {
                "searchable": True,
                "words": [
                    {
                        "text": w["text"],
                        "x0": round((w["x0"] / page_width) * 100000),
                        "y0": round((w["top"] / page_height) * 100000),
                        "x1": round((w["x1"] / page_width) * 100000),
                        "y1": round((w["bottom"] / page_height) * 100000),
                    }
                    for w in words
                ]
            }
    except Exception:
        return {"words": [], "searchable": False}


@app.get("/healthz")
async def healthz():
    return {"status": "ok", "service": "pdf-sidecar"}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8008"))
    # workers=1 is mandatory: we pass the `app` object (not an import string),
    # which uvicorn only allows single-process. Without it, uvicorn defaults
    # `workers` to the $WEB_CONCURRENCY env var that DigitalOcean's buildpack
    # sets (>1), then refuses to start ("You must pass the application as an
    # import string to enable 'reload' or 'workers'.") and exits.
    uvicorn.run(app, host="0.0.0.0", port=port, workers=1)
