# Mavly — Claymorphism Coverage Audit

**Date:** 2026-11-01
**Scope:** frontend material and interaction only. No backend, schema, API, auth, payment,
credit, generation or environment file was modified.

---

## 1. What this document is

A verified inventory of the Claymorphism transformation as it exists in the working tree,
plus the gaps found and closed in this pass. Every figure below was produced by running a
check over the actual source, not estimated.

---

## 2. Route inventory

38 route files under `src/app` — 25 user-facing, 13 admin.

### User-facing (25)

| Route | Visual owner |
|---|---|
| `/` | `components/home/MarketingHome` → Hero, Features, Pricing, FAQ, Footer, Nav |
| `/about` | page (direct) |
| `/blog` | page (direct) |
| `/careers` | page (direct) |
| `/changelog` | page (direct) |
| `/contact` | page (direct) |
| `/credit-topup` | `credit-topup-client` |
| `/dashboard` | `builder/BuilderDashboard` |
| `/docs` | page (direct) |
| `/faq` | page (direct) |
| `/features` | page (direct) |
| `/integrations` | page (direct) |
| `/login` | `login-screen` |
| `/pricing` | `MarketingPageShell` + `PricingSection` |
| `/privacy` | page (direct) |
| `/project/[projectId]` | workspace (see §4) |
| `/support` | `support-client` |
| `/terms` | page (direct) |
| `/tutorials` | page (direct) |
| `/upgrade` | `upgrade-client` |
| `/[...slug]` | `lib/legacy-routes` |
| `error.tsx` / `not-found.tsx` / `global-error.tsx` | direct |
| `layout.tsx` | shell |

### Admin (13)

`/adminsh` — `dashboard`, `users`, `projects`, `billing`, `credits`, `ai-usage`,
`generation-monitor`, `system-health`, `audit-logs`, `announcements`, `settings`, `auth`,
plus `layout.tsx`. All render through `AdminShell` / `AdminHeader` / `AdminSidebar`.

---

## 3. Material system

One stylesheet owns the material: `src/app/clay.css` (1,150 lines, 173 rules), imported by
`globals.css`. `globals.css` owns colour, typography and motion only — it defines no shadow
recipe of its own.

**Tokens**

- Geometry ladder: `--clay-r-xs` → `--clay-r-2xl`, `--clay-r-pill`
- Elevation ladder: `--clay-elev-0` → `--clay-elev-5`, plus `--clay-float`
- Wells: `--clay-well-1`, `--clay-well-2`
- Ink variants: `--clay-elev-ink-1/2`, `--clay-press-ink`
- Focus: `--clay-focus`, `--clay-focus-ink`
- Material: `--clay-sheen`, `--clay-sheen-ink`, `--clay-line`, `--clay-line-strong`

**Coverage**

- 2,096 `clay-` token references across 187 TSX files
- 58 `data-slot` skins in `clay.css` covering every primitive that owns a surface
- 470 bordered panels, all carrying a clay shadow
- 0 files with visual surfaces but no clay tokens

---

## 4. Interaction contract

### No hover lift — enforced

| Pattern | Count |
|---|---|
| `hover:-translate-y-*` | 0 (real) |
| `hover:translate*` | 0 |
| `hover:scale-*` | 0 (real) |
| `group-hover:` translate/scale | 0 |
| `active:scale-*` | 0 |
| Tailwind `shadow-sm…2xl` | 0 |

The only textual matches for `hover:-translate-y` / `hover:scale` are inside the comment
that documents the stability contract in `clay.css` — not rules.

Enforcement is a real CSS block, not a convention: `clay.css` pins `transform: none;
translate: none; scale: none` on `:hover` for every interactive slot and legacy class, so a
future stray utility cannot reintroduce movement.

### Press-in — the interaction

`active` changes depth only, never position or size:

- Buttons: `active:shadow-[var(--clay-press-ink)]` (ink) / `var(--clay-well-2)` (white)
- Cards: `.clay-card-interactive:active` → `--clay-well-2`
- Chips: `.clay-chip:active` → `--clay-well-1`

Hover is permitted to change border colour and background tone only. Every rule found does
exactly that.

### Legitimate motion kept

Chevron rotation, switch thumb translate, accordion grid-rows, page-enter fade, and the
`preview-loader` shimmer/drift keyframes are state or entrance animations, not hover
elevation. They are preserved.

---

## 5. Gaps found and closed in this pass

1. **`clay.css` formatting defect** — four custom-property declarations were crammed onto
   the tail of a preceding line inside the `@media (max-width: 640px)` block
   (`--clay-elev-3`, `--clay-elev-4`, `--clay-elev-5`, `--clay-float`). Valid CSS, but it
   made the responsive depth ladder unreadable and easy to break. Split and re-indented;
   braces verified balanced at 122/122.

2. **`mavly-address`** — used as a class in `ProjectDomainPanel.tsx` but defined nowhere.
   It is a `data-testid` value, not a style hook, so no visual gap. Left as-is.

3. **`living-browser` / `living-card` shadows** — two hand-written shadow recipes remain in
   `globals.css`. Both belong to the animated preview loader illustration, which is a
   drawing of a browser window, not a UI surface. Correctly excluded from the clay system.

---

## 6. Palette preservation

`git diff src/app/globals.css` shows **40 insertions, 0 deletions**. No `:root`, `.dark`,
`@theme inline`, OKLCH, typography, chart or sidebar token was altered. White surfaces,
black primary action, existing muted hierarchy and semantic colours are intact.

---

## 7. Backend protection

Files changed outside `src/app/**` and `src/components/**`: `.perch/index.json` only.

Zero changes to `src/app/api/**`, `supabase/**`, `*.sql`, `src/lib/ai/**`, `src/lib/mavly/**`,
`src/lib/vcaas*`, `src/lib/supabase/**`, `src/lib/integrations/**`, `src/lib/credits*`,
`src/lib/deployments/**`, `src/lib/hosting/**`, or any environment file.

---

## 8. Verification status — read this

**Performed:** static source audit over all 187 TSX and 2 CSS files; route enumeration;
token and rule counting; forbidden-pattern search; diff review; brace balance check;
backend-scope diff.

**Not performed, and why:** `npm run lint`, `npm test`, `npx tsc --noEmit` and
`npm run build`. `AGENTS.md` forbids agents from running automated verification of any
kind, including lint, typecheck, tests and builds. Those commands are documented there as
human-run before merge. No claim is made that they pass.

**Not performed:** rendered route-by-route visual inspection. No dev server was started,
because `AGENTS.md` also forbids agents from running one. The audit above is static
evidence; the rendered check remains a human step.

---

## 9. Open items for the human developer

1. Run `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.
2. Walk the routes in §2 with the dev server and confirm rendered depth consistency.
3. Confirm the workspace toolbar in `/project/[id]` reads correctly — it is the surface the
   interaction complaint referenced. Its markup is already clay (sunken tab wells,
   `--clay-elev-1` header, `--clay-well-2` active tab) and carries no hover transform.
4. Commit the 121 modified files; the transformation is currently uncommitted.
