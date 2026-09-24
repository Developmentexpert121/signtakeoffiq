---
name: Responsive UI patterns (web)
description: Non-obvious gotchas when making artifacts/web responsive on phones
---

# Horizontal-scroll tab strips need `shrink-0` on triggers
The shared `components/ui/tabs.tsx` `TabsTrigger` has `whitespace-nowrap` but NO
`shrink-0`. In a flex `TabsList` with `overflow-x-auto`, triggers will SHRINK to
fit (clipping text) instead of overflowing/scrolling.

**Why:** flex children default to `flex-shrink:1`; `whitespace-nowrap` only stops
text wrapping, not box shrinking — so without `shrink-0` you get squished tabs, no scroll.

**How to apply:** for a mobile-scrollable tab bar use
`TabsList className="flex overflow-x-auto sm:grid sm:grid-cols-N"` AND add
`shrink-0` to each `TabsTrigger`. (job-detail.tsx already wraps its TabsList in an
`overflow-x-auto` div, which is the alternative approach.)

# Mobile navigation pattern
Desktop `Sidebar` is `hidden md:flex`; `MobileNav` (Sheet drawer + hamburger) is
`md:hidden`. Both pull nav items from `hooks/use-nav-items.ts` so role-based
visibility never drifts between the two. Layout wraps them in layout.tsx.
