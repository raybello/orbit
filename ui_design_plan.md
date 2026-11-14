# Orbit UI Design Plan — Teams-Style Visual Redesign

> **Scope**: Pixel-accurate Microsoft Teams visual redesign with full Fluent 2 token system.
> **Platforms**: Web · Desktop · Mobile (shared token package).
> **Confirmed decisions**: Full Fluent-style token system + 6 preset themes; flat left-aligned
> messages (no bubbles); right panel toggle closed by default.

---

## 1. Architecture Overview

### Current state (what exists today)

| Layer | File(s) | Current state |
|-------|---------|---------------|
| Tokens | `packages/ui-tokens/tokens.css` | Light + Dark only; no Fluent accent system |
| Shell | `apps/web/src/styles/shell.css` | 60px rail + 280px section panel ✓ |
| Messages | `apps/web/src/styles/chat.css` | **Bubble-based** — needs flat Teams style |
| Right panel | `DetailsPanel.tsx` | Always mounted, no toggle |
| Theming | None | No preset themes, no accent color picker |

### Target state

```
packages/ui-tokens/
  tokens.css          ← Fluent 2 semantic tokens (light base)
  themes/
    dark.css          ← [data-theme="dark"] overrides
    hc.css            ← [data-theme="hc"] high-contrast overrides
    presets/
      midnight.css    ← 6 named presets (applied via data-preset="midnight" etc.)
      ocean.css
      forest.css
      rose.css
      slate.css
      amber.css
  accent/
    _accent.css       ← Accent mixin — applied with JS writing --accent-* vars
```

---

## 2. Fluent 2 Token System

### 2.1 Grid and spacing

Teams uses a **4 px base unit** throughout. All spacings, heights, and radii must be multiples of 4 px.

```
--space-1:  4px
--space-2:  8px
--space-3:  12px
--space-4:  16px
--space-5:  20px
--space-6:  24px
--space-8:  32px
--space-10: 40px
--space-12: 48px
```

### 2.2 Corner radius scale

Fluent 2 defines three tiers only:

| Token | Value | Used for |
|-------|-------|---------|
| `--radius-none` | 0px | Rail active indicator bar |
| `--radius-sm` | 4px | Buttons, inputs, chat list rows, chips |
| `--radius-md` | 8px | Cards, composer |
| `--radius-lg` | 12px | Modals, panel cards |
| `--radius-full` | 9999px | Avatars, pills, toggles |

> **Remove** `--radius-bubble` (18 px) and `--radius-composer` (22 px) from the token set; replace with `--radius-md` and `--radius-lg` respectively.

### 2.3 Typography scale

```css
/* Fluent 2 type ramp */
--type-caption:   12px / 16px / 400   /* timestamps, metadata */
--type-body-sm:   13px / 20px / 400   /* secondary text */
--type-body:      14px / 20px / 400   /* primary body, chat list previews */
--type-body-md:   14px / 20px / 600   /* chat list names, button labels */
--type-body-lg:   16px / 22px / 400   /* message text */
--type-subtitle:  18px / 24px / 600   /* panel headers, section titles */
--type-title:     20px / 28px / 600   /* modal titles */

/* Line-height tokens for JS alignment */
--lh-caption: 16px
--lh-body:    20px
--lh-message: 22px
```

Font stack remains `--font-stack` (Segoe UI on Windows, SF Pro everywhere else).

### 2.4 Light theme tokens (Fluent 2 neutral palette)

Replace the current `tokens.css` `:root` block with the following (keep existing bot color vars):

```css
:root {
  /* ── Background layers ── */
  --color-bg-canvas:       #F5F5F5;   /* window background (Teams outer gray) */
  --color-bg-nav:          #E8EBEF;   /* section panel / left sidebar */
  --color-bg-nav-hover:    #DEE1E5;
  --color-bg-nav-active:   #D5D8DD;
  --color-bg-stage:        #FFFFFF;   /* main chat / content area */
  --color-bg-elevated:     #FFFFFF;
  --color-bg-overlay:      #FFFFFF;   /* modal, popover */
  --color-bg-disabled:     #F0F0F0;

  /* ── Foreground ── */
  --color-fg-default:      #242424;
  --color-fg-subtle:       #616161;
  --color-fg-muted:        #8A8A8A;
  --color-fg-disabled:     #BDBDBD;
  --color-fg-on-accent:    #FFFFFF;

  /* ── Border ── */
  --color-border-default:  #D1D1D1;
  --color-border-subtle:   #E0E0E0;
  --color-border-stronger: #A0A0A0;
  --color-border-focus:    var(--accent-500, #5B5FC7);

  /* ── Accent (Teams purple default; overridden by accent picker) ── */
  --accent-100: #E5E5F7;
  --accent-200: #CCCCEF;
  --accent-300: #9999DF;
  --accent-400: #7777D3;
  --accent-500: #5B5FC7;   /* ← primary accent: buttons, active rail item, focus rings */
  --accent-600: #4D51B4;
  --accent-700: #3F43A0;
  --accent-800: #31358D;

  /* ── Status ── */
  --color-success:      #107C41;
  --color-success-bg:   #DFF6DD;
  --color-warn:         #835B00;
  --color-warn-bg:      #FFF4CE;
  --color-danger:       #C4262E;
  --color-danger-bg:    #FDE7E9;
  --color-info:         #0078D4;
  --color-info-bg:      #DEECF9;

  /* ── Message surface (flat Teams style — no bubbles) ── */
  --color-msg-bg-hover:   rgba(0,0,0,0.04);
  --color-msg-bg-focus:   rgba(0,0,0,0.06);
  --color-msg-mine-bar:   var(--accent-500);   /* 3px left bar on user's own messages */

  /* ── Nav rail (dark strip — unchanged from current) ── */
  --nav-rail-width:        48px;      /* Teams uses 48px, current is 60px — reduce */
  --nav-rail-bg:           #1F1F1F;   /* Teams near-black */
  --nav-rail-icon:         rgba(255,255,255,0.72);
  --nav-rail-icon-active:  #FFFFFF;
  --nav-rail-active-bar:   var(--accent-500);

  /* ── Section panel ── */
  --section-panel-width:   280px;
  --section-panel-bg:      var(--color-bg-nav);
  --section-panel-border:  var(--color-border-subtle);

  /* ── Right details panel ── */
  --details-panel-width:   360px;

  /* ── Spacing convenience ── */
  --space-1: 4px;  --space-2: 8px;   --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px;  --space-8: 32px; --space-10: 40px;

  /* ── Radius ── */
  --radius-sm:   4px;
  --radius-md:   8px;
  --radius-lg:   12px;
  --radius-full: 9999px;

  /* ── Typography ── */
  --font-stack: "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif;
  --font-mono-stack: ui-monospace, Consolas, "SF Mono", Menlo, monospace;

  /* ── Shadows ── */
  --shadow-nav:      0 1px 4px rgba(0,0,0,0.12);
  --shadow-card:     0 2px 8px rgba(0,0,0,0.12);
  --shadow-modal:    0 8px 32px rgba(0,0,0,0.20);
  --shadow-popover:  0 4px 16px rgba(0,0,0,0.14);

  /* ── Motion ── */
  --ease-standard: cubic-bezier(0.4,0,0.2,1);
  --ease-decel:    cubic-bezier(0,0,0.2,1);
  --ease-accel:    cubic-bezier(0.4,0,1,1);

  /* ── Legacy aliases (kept for backward compat; components should migrate) ── */
  --color-bg-chrome:       var(--color-bg-canvas);
  --color-bg-pane:         var(--color-bg-stage);
  --color-bg-sidebar:      var(--color-bg-nav);
  --color-text-primary:    var(--color-fg-default);
  --color-text-secondary:  var(--color-fg-subtle);
  --color-text-tertiary:   var(--color-fg-muted);
  --color-text-quaternary: var(--color-fg-disabled);
  --color-border-secondary: var(--color-border-subtle);
  --color-border-tertiary: var(--color-border-subtle);
  --color-primary:         var(--accent-500);
  --color-ink:             var(--color-fg-default);
}
```

### 2.5 Dark theme

```css
:root[data-theme='dark'] {
  /* ── Background layers ── */
  --color-bg-canvas:       #111111;
  --color-bg-nav:          #1A1A1A;   /* section panel */
  --color-bg-nav-hover:    #252525;
  --color-bg-nav-active:   #2F2F2F;
  --color-bg-stage:        #1E1E1E;   /* main chat area */
  --color-bg-elevated:     #2A2A2A;
  --color-bg-overlay:      #242424;
  --color-bg-disabled:     #2A2A2A;

  /* ── Foreground ── */
  --color-fg-default:      #E8E8E8;
  --color-fg-subtle:       #ABABAB;
  --color-fg-muted:        #767676;
  --color-fg-disabled:     #4A4A4A;
  --color-fg-on-accent:    #FFFFFF;

  /* ── Border ── */
  --color-border-default:  #383838;
  --color-border-subtle:   #2D2D2D;
  --color-border-stronger: #555555;
  --color-border-focus:    var(--accent-400, #7777D3);

  /* ── Accent (Teams dark uses same purple, slightly lighter) ── */
  --accent-100: #1E1E3A;
  --accent-200: #2A2A50;
  --accent-300: #4A4AA0;
  --accent-400: #7777D3;
  --accent-500: #8080D7;
  --accent-600: #9494DD;
  --accent-700: #AAAAE3;
  --accent-800: #BFBFEA;

  /* ── Status ── */
  --color-success:    #54B054;
  --color-success-bg: #0F2A0F;
  --color-warn:       #E5C365;
  --color-warn-bg:    #2A1E00;
  --color-danger:     #EF6868;
  --color-danger-bg:  #2D0A0A;
  --color-info:       #4CA6F7;
  --color-info-bg:    #001833;

  /* ── Message surface ── */
  --color-msg-bg-hover:  rgba(255,255,255,0.04);
  --color-msg-bg-focus:  rgba(255,255,255,0.07);
  --color-msg-mine-bar:  var(--accent-500);

  /* ── Nav rail ── */
  --nav-rail-bg:          #111111;
  --nav-rail-icon:        rgba(255,255,255,0.68);
  --nav-rail-icon-active: #FFFFFF;

  /* ── Shadows (flat in dark mode, border outlines instead) ── */
  --shadow-nav:    0 0 0 1px var(--color-border-subtle);
  --shadow-card:   0 0 0 1px var(--color-border-subtle);
  --shadow-modal:  0 0 0 1px var(--color-border-default);
  --shadow-popover:0 0 0 1px var(--color-border-default);
}
```

### 2.6 High-Contrast theme

Fluent 2 HC uses pure black/white with Windows SystemButtonFace/SystemButtonText semantics. Applied via `data-theme="hc"`.

```css
:root[data-theme='hc'] {
  --color-bg-canvas:       #000000;
  --color-bg-nav:          #000000;
  --color-bg-nav-hover:    #1AEBFF;  /* Windows: Highlight */
  --color-bg-nav-active:   #1AEBFF;
  --color-bg-stage:        #000000;
  --color-bg-elevated:     #000000;
  --color-bg-overlay:      #000000;

  --color-fg-default:      #FFFFFF;
  --color-fg-subtle:       #FFFFFF;
  --color-fg-muted:        #A6A6A6;  /* Windows: GrayText */
  --color-fg-disabled:     #A6A6A6;
  --color-fg-on-accent:    #000000;

  --color-border-default:  #FFFFFF;
  --color-border-subtle:   #FFFFFF;
  --color-border-stronger: #FFFFFF;
  --color-border-focus:    #FFFF00;  /* Windows: ButtonText active focus */

  /* Accent: yellow on black (Windows HC theme convention) */
  --accent-500: #FFFF00;
  --accent-600: #FFE500;

  /* Status */
  --color-success:    #00FF00;
  --color-success-bg: #000000;
  --color-warn:       #FFFF00;
  --color-warn-bg:    #000000;
  --color-danger:     #FF0000;
  --color-danger-bg:  #000000;

  /* Nav rail */
  --nav-rail-bg:          #000000;
  --nav-rail-icon:        #A6A6A6;
  --nav-rail-icon-active: #FFFFFF;
  --nav-rail-active-bar:  #FFFF00;

  /* No shadows — HC uses borders only */
  --shadow-nav:     0 0 0 1px #FFFFFF;
  --shadow-card:    0 0 0 1px #FFFFFF;
  --shadow-modal:   0 0 0 2px #FFFFFF;
  --shadow-popover: 0 0 0 1px #FFFFFF;
}
```

### 2.7 Six preset themes

Each preset overrides only the accent ramp and a few surface hues. Applied via `data-preset="<name>"` on `:root`, which COMPOUNDS with the light/dark base. Accent primary is `--accent-500`.

| Preset | Display name | `--accent-500` | Nav rail bg |
|--------|-------------|----------------|-------------|
| `default` | Orbit Purple (default) | `#5B5FC7` | `#1F1F1F` |
| `midnight` | Midnight Blue | `#0078D4` | `#032551` |
| `ocean` | Ocean Teal | `#0097A7` | `#003D47` |
| `forest` | Forest Green | `#107C41` | `#052612` |
| `rose` | Rose | `#E03A52` | `#2D0611` |
| `slate` | Slate | `#5C6670` | `#1A2026` |
| `amber` | Amber | `#C8880B` | `#1F1600` |

Each preset file (`packages/ui-tokens/themes/presets/<name>.css`) redefines the full `--accent-100` through `--accent-800` ramp and the nav-rail bg. Dark + HC themes remain intact under their own `data-theme` selector.

**Example** (`packages/ui-tokens/themes/presets/midnight.css`):

```css
:root[data-preset='midnight'] {
  --accent-100: #DEECF9;
  --accent-200: #BDD8F4;
  --accent-300: #69B1E5;
  --accent-400: #3A96D9;
  --accent-500: #0078D4;
  --accent-600: #005BA1;
  --accent-700: #00407E;
  --accent-800: #002451;
  --nav-rail-bg: #032551;
}
:root[data-theme='dark'][data-preset='midnight'] {
  --accent-500: #3A96D9;
  --nav-rail-bg: #021A3A;
}
```

### 2.8 Accent color picker (custom)

A free-form accent color input writes CSS custom properties directly to `:root` via JavaScript, overriding the preset ramp. The picker computes the full ramp from a single HEX input using a lightness scale:

```ts
// packages/ui-tokens/src/accentRamp.ts
export function buildAccentRamp(hex: string): Record<string, string> {
  // Parse hex → HSL, then scale lightness to fixed stops
  const stops = [0.92, 0.84, 0.70, 0.60, 0.50, 0.42, 0.34, 0.26];
  // Returns { '--accent-100': ..., '--accent-500': ..., etc. }
}
```

The store (`configStore.ts`) exposes `setAccentColor(hex)` which calls `buildAccentRamp`, writes vars to `document.documentElement.style`, and persists the hex to `localStorage` as `orbit_accent`.

---

## 3. Nav Rail — Exact Specification

### 3.1 Dimensions

| Property | Value | Note |
|----------|-------|------|
| Width | **48 px** | Reduced from current 60 px to match Teams |
| Background | `--nav-rail-bg` | Dark in both light + dark themes |
| Icon area | 20×20 px | SVG icons from `lucide-react` or `@fluentui/react-icons` |
| Item height | **52 px** | Teams measures ~52 px per nav item |
| Item gap | 0 px | No gap; items butt together |
| Active indicator | 3×24 px bar, left edge, `border-radius: 0 3px 3px 0` | Colour: `--accent-500` |
| Label | 10 px / 12 px leading, centered under icon | Visible always (not on hover) |
| Titlebar spacer | 36 px height | macOS traffic lights clearance |
| Footer | Account avatar 32×32 px + Settings gear 28×28 px | Matches Teams bottom items |

### 3.2 CSS changes required in `shell.css`

```css
/* Change: */
--nav-rail-width: 48px;   /* was 60px */

.nav-rail__item {
  height: 52px;            /* was 56px */
  gap: 2px;
}
.nav-rail__item.is-active::before {
  /* Teams indicator: left pill, 3px wide, 24px tall, vertically centred */
  top: 50%; transform: translateY(-50%);
  height: 24px;            /* was top:12 bottom:12 */
  background: var(--nav-rail-active-bar, var(--accent-500));
}
```

### 3.3 Icon sizes and states

| State | Icon opacity | Label opacity | Background |
|-------|-------------|---------------|-----------|
| Rest | 72% white | 72% white | transparent |
| Hover | 100% white | 100% white | rgba(255,255,255,0.08) |
| Active | 100% white | 100% white | rgba(255,255,255,0.12) |
| Active + hover | 100% white | 100% white | rgba(255,255,255,0.16) |

---

## 4. Section Panel — Exact Specification

### 4.1 Dimensions and typography

| Property | Current | Target |
|----------|---------|--------|
| Width | 280 px | **280 px** (unchanged) |
| Background | `#FAFAFA` | `var(--color-bg-nav)` → `#E8EBEF` light / `#1A1A1A` dark |
| Panel header height | 60 px | **48 px** (Teams is denser) |
| Panel header font | 17 px / 600 | **16 px / 600** |
| Row height | 54 px | **52 px** |
| Row padding | 8 px | **8px 12px** |
| Row border-radius | 12 px | **4 px** (`--radius-sm`) |
| Row hover bg | `#1C1C1C0F` | `var(--color-bg-nav-hover)` |
| Row active bg | `#1C1C1C14` | `var(--color-bg-nav-active)` |

### 4.2 Chat list row (Teams density)

Teams chat list row contains:

```
[ Avatar 32×32 ] [ Name + preview column ] [ Time (top right) + Unread badge (bottom right) ]
```

Row spec:
- Total height: **52 px**
- Left padding: 12 px
- Avatar: 32×32 px circle, `--radius-full`
- Name: `--type-body-md` (14/20/600), `--color-fg-default`
- Preview: `--type-body-sm` (13/20/400), `--color-fg-subtle`, single line, ellipsis
- Time: `--type-caption` (12/16/400), `--color-fg-muted`, top-right aligned
- Unread badge: 18 px min-width pill, `--accent-500` bg, white text, 10 px font, bottom-right

### 4.3 Section panel header buttons

The Chat section header contains two action buttons (`+` New Bot, `⊕` New Group Chat). These replace the existing icons with explicit labeled icon-buttons:

```
[Chat] ·············· [+ New Bot] [⊕ Group]
```

Button spec:
- Height: 28 px
- Padding: 0 8 px
- Background: transparent → `var(--color-bg-nav-hover)` on hover
- Border: none
- Border-radius: `--radius-sm` (4 px)
- Icon + label: 12 px icon + 12 px text, 6 px gap

---

## 5. Main Conversation Area — Flat Message Layout

This is the largest visual change. Remove all bubble styles and replace with Teams-style flat messages.

### 5.1 Message row anatomy

```
┌─────────────────────────────────────────────────────────┐
│ [AVT]  BotName          2:34 PM                         │  ← header row (shown on first in group)
│        Message text goes here, can be very long and     │
│        wrap across multiple lines naturally.            │
│                                                         │
│        [reaction bar hidden until hover]                │
└─────────────────────────────────────────────────────────┘
```

**Header row** (first message in a consecutive group from the same sender):
- Avatar: 32×32 px, `--radius-full`, `margin-right: 12px`
- Sender name: `--type-body-md` (14/20/600), `--color-fg-default`
- Timestamp: `--type-caption` (12/16/400), `--color-fg-muted`, `margin-left: 8px`

**Follow-up rows** (same sender, within 7 minutes):
- No avatar, no name — replaced by 42 px left margin (avatar width + gap)
- Timestamp on hover only (abs-positioned, left of the 42 px margin)
- Background highlight on hover: `var(--color-msg-bg-hover)`

**Message text**:
- Font: `--type-body-lg` (16/22/400) — slightly larger than Teams (14) for readability
- Color: `--color-fg-default`
- `max-width: none` — full width of the conversation column
- `white-space: pre-wrap`
- Markdown rendered as before

**User's own messages** (right-aligned in Teams — Orbit: left-aligned with accent bar):
- Same flat layout but with a 3 px `--accent-500` left border on the message row
- Background: `rgba(var(--accent-500-rgb), 0.06)` tinted hover

### 5.2 CSS architecture changes

**Remove** from `chat.css`:
- `.bubble`, `.bubble-wrap`, `.bubble.is-agent`, `.bubble.is-user`
- `.bubble.is-first/.is-mid/.is-last` (corner radius grouping)
- `.group.is-right` / `flex-direction: row-reverse`

**Add** to `chat.css`:

```css
/* ── Flat message row ── */
.msg-group { display: flex; flex-direction: column; padding: 0 16px; width: 100%; }
.msg-group + .msg-group { margin-top: 16px; }

.msg-row {
  position: relative; display: flex; align-items: flex-start; gap: 12px;
  padding: 2px 0; border-radius: var(--radius-sm);
  transition: background-color 100ms var(--ease-standard);
}
.msg-row:hover { background: var(--color-msg-bg-hover); }
.msg-row:focus-visible { background: var(--color-msg-bg-focus); outline: none; }

/* Avatar column — always 32px wide; hidden on follow-up rows */
.msg-row__avatar { width: 32px; flex-shrink: 0; }
.msg-row--follow .msg-row__avatar { visibility: hidden; }

/* Body */
.msg-row__body { flex: 1 1 0; min-width: 0; }

/* Header (name + time) */
.msg-row__header {
  display: flex; align-items: baseline; gap: 8px;
  margin-bottom: 2px;
}
.msg-row--follow .msg-row__header { display: none; }
.msg-row__name {
  font-size: 14px; font-weight: 600; line-height: 20px;
  color: var(--color-fg-default);
}
.msg-row__time {
  font-size: 12px; line-height: 16px; color: var(--color-fg-muted);
}

/* Text */
.msg-row__text {
  font-size: 15px; line-height: 22px; color: var(--color-fg-default);
  white-space: pre-wrap; overflow-wrap: anywhere;
}

/* User's own messages — left-aligned with accent bar */
.msg-row--mine {
  border-left: 3px solid var(--accent-500);
  padding-left: 10px;   /* compensate for border */
  margin-left: -13px;   /* pull back to align avatar */
}
.msg-row--mine .msg-row__name { color: var(--accent-600); }

/* Hover timestamp for follow-up rows */
.msg-row--follow .msg-row__hover-time {
  position: absolute; left: -48px; top: 2px;
  font-size: 11px; color: var(--color-fg-muted);
  opacity: 0; transition: opacity 100ms;
  white-space: nowrap; pointer-events: none;
}
.msg-row--follow:hover .msg-row__hover-time { opacity: 1; }

/* Streaming cursor */
.msg-row--streaming .msg-row__text::after {
  content: ''; display: inline-block; width: 7px; height: 7px;
  margin-left: 4px; border-radius: 50%;
  background: currentColor; opacity: 0.4; vertical-align: middle;
  animation: breathe 1s ease-in-out infinite;
}
```

### 5.3 Transcript column

```css
.transcript__col {
  max-width: 860px;   /* Teams message column is narrower */
  padding: 16px 0;    /* remove horizontal padding — msg-group owns it */
  gap: 0;             /* msg-groups handle their own spacing */
}
```

---

## 6. Conversation Header — Top Bar

### 6.1 Teams-style top bar spec

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  🤖 Bot Name   [Chat ▾] [Files]                           [⋯] [⊞ panels] │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Measurements**:
- Height: **48 px**
- Background: `var(--color-bg-stage)`
- Bottom border: `1px solid var(--color-border-subtle)`
- Left padding: 16 px (aligns with message avatars)
- Avatar: 32×32 px
- Bot name: `--type-body-md` (14/20/600), `--color-fg-default`
- Status dot: 10×10 px, `--radius-full`, green/yellow/gray

**Tab strip** (Chat / Files):
- Tabs: 14 px / 400, `--color-fg-subtle` rest → `--color-fg-default` active
- Active tab underline: 2 px `--accent-500`, bottom of bar
- Tab height: 48 px (full bar height, bottom-border trick)

**Right-side icons** (from left to right):
1. `...` more menu — 32×32 px icon button
2. `⊞` toggle details panel — 32×32 px icon button, **active state uses `--accent-500` bg tint**

**CSS** (new `.conv-header` class replacing `.chat__header`):

```css
.conv-header {
  display: flex; align-items: center; gap: 8px;
  height: 48px; flex-shrink: 0; padding: 0 8px 0 16px;
  background: var(--color-bg-stage);
  border-bottom: 1px solid var(--color-border-subtle);
}
.conv-header__identity { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.conv-header__name {
  font-size: 14px; font-weight: 600; line-height: 20px; color: var(--color-fg-default);
}
.conv-header__tabs {
  display: flex; align-items: stretch; height: 100%; margin-left: 8px; gap: 0;
}
.conv-tab {
  display: flex; align-items: center; padding: 0 12px; height: 100%;
  font-size: 14px; color: var(--color-fg-subtle); position: relative;
  transition: color 120ms;
}
.conv-tab:hover { color: var(--color-fg-default); }
.conv-tab.is-active {
  color: var(--color-fg-default);
  font-weight: 600;
}
.conv-tab.is-active::after {
  content: ''; position: absolute; bottom: 0; left: 12px; right: 12px;
  height: 2px; background: var(--accent-500); border-radius: 2px 2px 0 0;
}
.conv-header__spacer { flex: 1 1 0; }
.conv-header__actions { display: flex; align-items: center; gap: 2px; }
.conv-header__icon-btn {
  width: 32px; height: 32px; border-radius: var(--radius-sm);
  color: var(--color-fg-subtle); display: flex; align-items: center; justify-content: center;
  transition: background 120ms, color 120ms;
}
.conv-header__icon-btn:hover { background: var(--color-bg-nav-hover); color: var(--color-fg-default); }
.conv-header__icon-btn.is-active {
  background: color-mix(in srgb, var(--accent-500) 12%, transparent);
  color: var(--accent-500);
}
```

---

## 7. Composer — Teams Style

### 7.1 Teams composer anatomy

```
┌─────────────────────────────────────────────────────────────────────┐
│ [Format] [Attach] [Emoji] [GIF]  ···  [text input area]  [Send ▶]  │
└─────────────────────────────────────────────────────────────────────┘
```

**Measurements**:
- Outer container min-height: **44 px**, max-height: 200 px
- Border: `1px solid var(--color-border-default)` → `var(--accent-500)` on focus
- Border-radius: `var(--radius-md)` (8 px) — was 22 px composer radius
- Background: `var(--color-bg-stage)` with slight elevation in dark
- Toolbar row height: 32 px (shown when user clicks Format or when multiline)
- Send button: 32×32 px circle, `--accent-500` background, white icon

**Toolbar icons** (left of input or below in expanded mode):
1. `Aa` Format toggle — expands a formatting toolbar above the input
2. `📎` Attach file
3. `😊` Emoji picker
4. `⟳` Loop/routine toggle (Orbit-specific)

```css
.composer {
  border-radius: var(--radius-md);    /* was var(--radius-composer) */
  border: 1px solid var(--color-border-default);
  background: var(--color-bg-stage);
}
.composer:focus-within {
  border-color: var(--accent-500);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent-500) 20%, transparent);
}
.composer__toolbar {
  display: flex; align-items: center; gap: 2px; padding: 4px 8px 0;
  border-bottom: 1px solid var(--color-border-subtle);
}
.composer__toolbar-btn {
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  color: var(--color-fg-subtle);
  transition: background 120ms, color 120ms;
}
.composer__toolbar-btn:hover { background: var(--color-bg-nav-hover); color: var(--color-fg-default); }
.composer__cta {
  width: 32px; height: 32px; border-radius: 50%;
  background: var(--accent-500);
  color: var(--color-fg-on-accent);
}
.composer__cta:hover { background: var(--accent-600); }
.composer__cta:disabled { background: var(--color-bg-disabled); color: var(--color-fg-disabled); }
```

---

## 8. Right Details Panel — Toggle Behavior

### 8.1 Current state

The right details panel (`DetailsPanel.tsx`) is always mounted and always takes `--details-panel-width` (360 px). There is no toggle.

### 8.2 Target state

- **Closed by default** — the main chat area takes full width when the panel is closed.
- **Toggle icon** in the conversation top bar (the `⊞` icon, rightmost button).
- Smooth slide-in/out animation (280 ms, `--ease-decel`).
- Panel state persisted to `localStorage` as `orbit_panel_open` per-bot.

### 8.3 Implementation

**`configStore.ts`** — add:
```ts
detailsPanelOpen: boolean;         // default: false
toggleDetailsPanel: () => void;
setDetailsPanelOpen: (open: boolean) => void;
```

**`shell.css`** changes:
```css
.details-panel {
  flex: 0 0 var(--details-panel-width);
  width: var(--details-panel-width);
  overflow: hidden;
  transition: width 280ms var(--ease-decel), flex-basis 280ms var(--ease-decel);
}
.details-panel.is-closed {
  width: 0;
  flex-basis: 0;
}
```

**`ChatView.tsx`** — the `⊞` button in `ConvHeader` calls `toggleDetailsPanel()` and sets `is-active` class when `detailsPanelOpen`.

### 8.4 Panel tabs (unchanged)

The panel retains its current tabs: Activity · Tasks · Library · Engine. Width remains 360 px.

---

## 9. Settings — App Settings Panel

### 9.1 Teams-style settings layout

Settings opens as a full-screen overlay (like Teams' `gear → Manage account`), not a modal:

```
┌──── Settings ────────────────────────────────────────────┐
│  ← Back                                                  │
│  [General]  [Notifications]  [Appearance]  [Bots]        │
│  ─────────────────────────────────────────────────────── │
│  <section content>                                       │
└──────────────────────────────────────────────────────────┘
```

### 9.2 Appearance tab (new)

This tab hosts the theme picker and accent color selector:

**Theme row**:
```
Theme:   [○ Light]  [● Dark]  [○ High Contrast]
```

**Preset row**:
```
Color theme:  [Orbit Purple ▼]
              Orbit Purple / Midnight Blue / Ocean Teal / Forest Green / Rose / Slate / Amber
```

**Accent color row** (shown when "Custom" is selected in preset):
```
Accent color:  [████] #5B5FC7  [Pick]
```

### 9.3 Bots tab — Auth credentials table

Each row:

| Bot | Provider | Model | Credentials |
|-----|---------|-------|------------|
| Primary (Doug) | Anthropic | claude-opus-5-5 | ✓ Configured |
| ResearchBot | ← Primary | claude-opus-5-5 | ✓ Inherited |
| CoderBot | OpenAI | gpt-4o | ✗ Not set [Configure] |

The "Configure" button opens the existing `EngineSettings` modal.

---

## 10. Calendar View — Teams Style

### 10.1 Layout

```
┌── Calendar ────────────────────────────────────────────────────────┐
│  < November 2026 >    [Day] [Week] [Month]           [+ New Event] │
│  ─────────────────────────────────────────────────────────────────  │
│  Mon  Tue  Wed  Thu  Fri  Sat  Sun                                  │
│   2    3    4    5    6    7    8                                    │
│  [event chips in each cell]                                         │
└────────────────────────────────────────────────────────────────────┘
```

### 10.2 Event chip colors

Calendar events are assigned to a bot; use that bot's avatar color (`--bot-*`) for the chip:

```css
.cal-event-chip {
  height: 20px; padding: 0 6px; border-radius: var(--radius-sm);
  font-size: 12px; font-weight: 500; line-height: 20px;
  background: var(--bot-color, var(--accent-500));
  color: #FFFFFF;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
```

### 10.3 FullCalendar token override

FullCalendar exposes CSS custom properties. Map Orbit tokens to FC vars:

```css
.fc {
  --fc-border-color: var(--color-border-subtle);
  --fc-today-bg-color: color-mix(in srgb, var(--accent-500) 8%, transparent);
  --fc-event-bg-color: var(--accent-500);
  --fc-event-border-color: var(--accent-600);
  --fc-button-bg-color: var(--color-bg-nav);
  --fc-button-active-bg-color: var(--color-bg-nav-active);
  --fc-button-text-color: var(--color-fg-default);
}
```

---

## 11. Files View

### 11.1 Layout

Three sub-tabs: **Library** · **Attachments** · **Workspace**

Each tab shows a flat table:

| Name | Bot | Type | Modified | Size |
|------|-----|------|----------|------|

Table token spec:
- Header height: 36 px, `--type-body-sm` (13/20/600), `--color-fg-subtle`
- Row height: 40 px, `--type-body` (14/20/400)
- Row hover: `var(--color-bg-nav-hover)`
- Selected row: `var(--color-bg-nav-active)` + left `--accent-500` bar

---

## 12. Mobile (Expo) Adaptations

### 12.1 Token sharing

The `packages/ui-tokens/src/index.ts` exports JS token objects alongside the CSS. The Expo app imports tokens and applies them via React Native `StyleSheet`. No CSS; JS token values map 1:1.

```ts
// packages/ui-tokens/src/index.ts
export const light = { bgCanvas: '#F5F5F5', bgNav: '#E8EBEF', ... };
export const dark  = { bgCanvas: '#111111', bgNav: '#1A1A1A', ... };
```

### 12.2 Bottom tab bar (mobile nav)

On mobile, the NavRail becomes a bottom tab bar (5 items max: Chat, Calendar, Files, Computers, Skills). Same 48 px height, `--nav-rail-bg` background.

### 12.3 Flat messages on mobile

Same flat-message layout. Avatar: 28×28 px. Font: `--type-body` (14/20).

---

## 13. Component Migration Map

| Component | File | Change |
|-----------|------|--------|
| `Transcript.tsx` | `apps/web/src/components/Transcript.tsx` | Replace `<div class="bubble ...">` with `<div class="msg-row ...">` |
| `BubbleWrap.tsx` (if exists) | — | Delete |
| `ConvHeader` (new) | `apps/web/src/components/ConvHeader.tsx` | Replace `.chat__header` pill; add tabs + toggle btn |
| `DetailsPanel.tsx` | `apps/web/src/components/DetailsPanel.tsx` | Add `is-closed` class + CSS transition |
| `configStore.ts` | `apps/web/src/configStore.ts` | Add `detailsPanelOpen`, `toggleDetailsPanel` |
| `Composer.tsx` | `apps/web/src/components/Composer.tsx` | Restyle; add toolbar row; Teams-radius |
| `AppSettings.tsx` | `apps/web/src/components/AppSettings.tsx` | Add Appearance tab with theme + accent picker |
| `shell.css` | token + layout | nav-rail-width 48px; msg-group no bubbles |
| `tokens.css` | palette | Full Fluent 2 token rewrite |
| `chat.css` | messages | Remove bubble CSS; add msg-row CSS |
| Nav rail CSS | `shell.css` | Active indicator, 52px items, accent bar |

---

## 14. Implementation Phases

This plan feeds Phase 3 of `phases.md`. Suggested sub-phases:

| Sub-phase | Scope | Files touched |
|-----------|-------|---------------|
| **3A** — Tokens | Rewrite `tokens.css`, add dark/hc/preset files, build `accentRamp.ts` | `packages/ui-tokens/**` |
| **3B** — Shell geometry | Nav rail 48px; active indicator accent; section panel bg/density | `shell.css`, `tokens.css` |
| **3C** — Flat messages | Replace bubbles with msg-row in `chat.css` + `Transcript.tsx` | `chat.css`, `Transcript.tsx` |
| **3D** — Conv header | New `ConvHeader.tsx`; tabs; panel toggle button | `ConvHeader.tsx`, `configStore.ts`, `DetailsPanel.tsx`, `chat.css` |
| **3E** — Composer | Restyle; toolbar row; Teams-radius; accent focus ring | `chat.css`, `Composer.tsx` |
| **3F** — Appearance settings | Theme picker + preset dropdown + accent color picker | `AppSettings.tsx`, `configStore.ts` |
| **3G** — Calendar + Files | FullCalendar token overrides; Files table | `calendar.css`, `CalendarView.tsx`, `files.css` |
| **3H** — Mobile tokens | Export JS token objects; bottom tab bar | `packages/ui-tokens/src/index.ts`, Expo nav |

Sub-phases 3A through 3E can begin in parallel after tokens (3A) land.

---

## 15. Testing Checklist

- [ ] Light theme: all token vars resolve, no `#1C1C1C` hardcoded values in migrated components
- [ ] Dark theme: `data-theme="dark"` on `:root` triggers correct overrides
- [ ] High-contrast: `data-theme="hc"` — all interactive elements have visible 1px outlines
- [ ] Preset themes: each `data-preset` changes accent color correctly in both light and dark
- [ ] Custom accent: `setAccentColor('#E91E63')` updates all `--accent-*` vars and UI reflects immediately
- [ ] Flat messages: no bubble backgrounds, name + timestamp header on first row, absent on follow-ups
- [ ] Right panel: closed by default on fresh load; toggle opens/closes smoothly; state persists across reloads
- [ ] Nav rail: 48px wide, 52px item height, active indicator bar uses `--accent-500`
- [ ] Composer: Teams-radius (8px), accent focus ring, send button uses `--accent-500`
- [ ] Mobile: dark/light tokens apply correctly; bottom tab bar shows in Expo
- [ ] HC: no non-transparent backgrounds on interactive states; all focus rings are 2px yellow (#FFFF00)
