---
name: trading-agent
description: The owner's copy-trading bot as a Y2K messenger buddy, frosted candy panels on an icy periwinkle ground.
colors:
  ground: "#E7ECFF"
  ground-glow-lilac: "#E8C8FF"
  ground-glow-sky: "#B5EBFF"
  ground-glow-blush: "#FFE3F1"
  panel: "rgba(255, 255, 255, .58)"
  panel-solid: "#F8F9FF"
  line: "#CBD3F7"
  line-soft: "#E1E6FB"
  ink: "#15163A"
  ink-soft: "#474C7C"
  muted: "#62679A"
  grape: "#5B3DF0"
  grape-deep: "#4A2FD6"
  grape-soft: "#ECE8FF"
  on-grape: "#FFFFFF"
  lime: "#B8F53A"
  screen: "#D6F8F3"
  screen-line: "#9FE3D9"
  screen-ink: "#0D5951"
  sun: "#F5B20F"
  sun-ink: "#7A5600"
  sun-soft: "#FFF6D6"
  sun-line: "#EED98C"
  win: "#0A8A5E"
  win-soft: "#DDF6EA"
  loss: "#D2353C"
  loss-soft: "#FCE0E1"
  bubblegum: "#E0408E"
  blue: "#2F6BFF"
  online: "#18A866"
  idle: "#E89B00"
  away: "#A5ABCF"
  launch: "#6A57E8"
  live-red: "#FF3B47"
  disconnected: "#FFD0D3"
  night-ground: "#121130"
  night-panel: "rgba(31, 29, 74, .88)"
  night-panel-solid: "#1F1D4A"
  night-line: "#34317A"
  night-line-soft: "#2A2862"
  night-ink: "#F0F1FF"
  night-ink-soft: "#C0C3EE"
  night-muted: "#ABAFE0"
  night-grape: "#4029C2"
  night-grape-deep: "#6A4EFF"
  night-grape-soft: "#2B2670"
  night-screen: "#0E3A40"
  night-screen-line: "#1D6067"
  night-screen-ink: "#A6F3E8"
  night-sun-ink: "#FFD36B"
  night-sun-soft: "#352B0E"
  night-win: "#3FD69A"
  night-win-soft: "#123A2C"
  night-loss: "#FF7378"
  night-loss-soft: "#46191E"
  night-bubblegum: "#FF7AB8"
  night-blue: "#7EA2FF"
  night-away: "#5E6296"
  night-sun-line: "#5E4C14"
  night-launch: "#B3A8FF"
typography:
  display:
    fontFamily: "Pixelify Sans, Rubik, monospace"
    fontSize: "74px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  wordmark:
    fontFamily: "Pixelify Sans, Rubik, monospace"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.01em"
  badge:
    fontFamily: "Pixelify Sans, Rubik, monospace"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.06em"
  headline:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.45
  title:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.45
  figure-small:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.45
    fontFeature: "tnum"
  body:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  body-table:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum"
  label:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.45
  caption:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.3
  display-phone:
    fontFamily: "Pixelify Sans, Rubik, monospace"
    fontSize: "46px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.01em"
  delta:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.45
  micro:
    fontFamily: "Rubik, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 700
    lineHeight: 1.3
    fontFeature: "tnum"
  address:
    fontFamily: "ui-monospace, JetBrains Mono, monospace"
    fontSize: "12.5px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  tiny: "4px"
  focus: "6px"
  badge: "7px"
  control: "9px"
  box: "10px"
  screen: "12px"
  strip: "14px"
  panel: "16px"
  pill: "999px"
spacing:
  hair: "4px"
  tight: "6px"
  sm: "8px"
  md: "10px"
  gap: "12px"
  inset: "14px"
  gutter: "16px"
components:
  titlebar:
    backgroundColor: "{colors.grape}"
    textColor: "{colors.on-grape}"
    height: "48px"
    padding: "0 16px"
  mode-badge:
    backgroundColor: "{colors.lime}"
    textColor: "{colors.ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.badge}"
    padding: "5px 9px 4px"
  tab:
    textColor: "{colors.on-grape}"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  tab-selected:
    backgroundColor: "{colors.on-grape}"
    textColor: "{colors.grape-deep}"
    rounded: "{rounded.pill}"
    padding: "6px 13px"
  away-message:
    backgroundColor: "{colors.sun-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.strip}"
    padding: "8px 14px"
  away-message-online:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.strip}"
    padding: "8px 14px"
  away-message-busy:
    backgroundColor: "{colors.loss-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.strip}"
    padding: "8px 14px"
  away-pill:
    backgroundColor: "{colors.sun}"
    rounded: "{rounded.pill}"
    padding: "4px 11px"
  away-pill-online:
    backgroundColor: "{colors.online}"
    textColor: "{colors.on-grape}"
    rounded: "{rounded.pill}"
    padding: "4px 11px"
  panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "12px 14px"
  bag-screen:
    backgroundColor: "{colors.screen}"
    textColor: "{colors.ink}"
    rounded: "{rounded.screen}"
    padding: "10px 14px 4px"
  pill:
    backgroundColor: "{colors.grape-soft}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  pill-ok:
    backgroundColor: "{colors.win-soft}"
    textColor: "{colors.win}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  pill-warn:
    backgroundColor: "{colors.sun-soft}"
    textColor: "{colors.sun-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  pill-bad:
    backgroundColor: "{colors.loss-soft}"
    textColor: "{colors.loss}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  filter-chip:
    backgroundColor: "{colors.grape-soft}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  filter-chip-active:
    backgroundColor: "{colors.grape-deep}"
    textColor: "{colors.on-grape}"
    rounded: "{rounded.pill}"
    padding: "2px 9px"
  button-save:
    backgroundColor: "{colors.grape-deep}"
    textColor: "{colors.on-grape}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  button-save-hover:
    backgroundColor: "{colors.grape}"
  button-secondary:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "5px 12px"
  input-limit:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "5px 8px"
    width: "92px"
  mem-tag:
    backgroundColor: "{colors.grape-soft}"
    textColor: "{colors.grape-deep}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  mem-tag-confirmed:
    backgroundColor: "{colors.win-soft}"
    textColor: "{colors.win}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  warnbox:
    backgroundColor: "{colors.sun-soft}"
    textColor: "{colors.ink}"
    rounded: "{rounded.box}"
    padding: "7px 10px"
  tooltip:
    backgroundColor: "{colors.panel-solid}"
    textColor: "{colors.ink}"
    rounded: "{rounded.box}"
    padding: "6px 9px"
---

# Design System: trading-agent

## Overview

**Creative North Star: "The Bot Is Online"**

The dashboard is the bot's messenger window, circa 2003. The bot is a buddy who is online, idle or away; its status is one away message across the top; the traders it copies are its buddy list, each with a pixel buddy icon; what it is doing scrolls by as a chat log; and its money sits on an aqua status screen with a big pixel figure. It is the owner's own bot, never a trading terminal: no KPI tile row, no hero equity chart, no dark terminal.

The material is frosted candy. An icy periwinkle ground carries three soft colour glows (lilac top left, sky right, blush bottom); over it float translucent white panels with a sheen, a bright top edge and a soft drop, like early-2000s glossy UI made gentle. Colour is candy but every candy has a job: grape is the app's own chrome and actions, lime is the PAPER badge and the live dot, aqua is money, sun-yellow means away or waiting, green and red only ever mean won or lost and working or broken. The night skin keeps the same candy on a deep indigo ground.

Density is high but calm: everything a minute-long check needs fits a 1366×768 window, 13px Rubik body, 12px gaps. Loudness is reserved for state: the away strip turns yellow or red only when something is off, the bag gets one messenger-style nudge when a trade closes, and the rest stays still.

**Key Characteristics:**
- Grape title bar with a lime PAPER badge, pixel wordmark, live dot and pill tabs.
- One full-width away message, coloured by the bot's state, with a 12×12 pixel face.
- Frosted translucent panels (16px corners, 14px blur, inset bevel, soft drop) with a tinted header band.
- An aqua bag screen holding the only display-size figure, in Pixelify Sans, above a step chart.
- Pixel identicon buddy icons whose size follows the trader's grade; online, idle and away dots.
- A chat-log feed in a sticky right rail on every tab: time, coloured lowercase speaker tag with a colon, text.
- Same candy accents in the night skin; only ground, panels, ink and grape depth change.

## Colors

A cool periwinkle-and-white base lit by a small, strictly assigned candy set: grape, lime, aqua, sun-yellow and bubblegum.

### Primary
- **Grape** (`grape`): the title bar background and the app's identity. Its deeper sibling **Deep Grape** (`grape-deep`) carries the app's own actions and selections: the save button, the active filter chip, meter fills, chart bars, the selected tab's text, the focus ring, the caret and the "on schedule" part state. **Grape Mist** (`grape-soft`) is the quiet tint behind neutral pills, filter chips, meter tracks, row hover and new chat-log lines.

### Secondary
- **Aqua Screen** (`screen`, `screen-line`, `screen-ink`): the bag status screen and nothing else. Its ink colours the chart ticks, gridlines and dashed start line inside the screen.
- **Lime** (`lime`): the PAPER mode badge, the "live" connection dot, the online face's eyes, and the focus ring colour inside the title bar.

### Tertiary
- **Sun-Yellow** (`sun`, `sun-soft`, `sun-line`, `sun-ink`): away and waiting. The away strip's default fill, the away pill, warn pills, warn boxes, warn meter fills, "changed its mind" memory tags and warning chat-log tags.
- **Bubblegum** (`bubblegum`): trader buy events in the chat log and the hovered bar in bar charts. **Blue** (`blue`) marks trader sell events.

### Neutral
- **Icy Periwinkle** (`ground`) with **Lilac, Sky and Blush Glows** (`ground-glow-*`): the page ground, three fixed radial glows over a flat fill.
- **Frost** (`panel`): translucent white panel fill, always with backdrop blur. **Frost Solid** (`panel-solid`) where translucency would break: sticky table headers, inputs, buttons, tooltips, identicon tiles.
- **Periwinkle Line** (`line`) for panel borders and table header rules; **Soft Line** (`line-soft`) for row dividers, panel header bands' bottom edge and stat dividers.
- **Midnight Ink** (`ink`), **Dusk Ink** (`ink-soft`) and **Lavender Grey** (`muted`): text in three steps; muted is for labels, times and secondary lines.
- **Win Green** (`win`, `win-soft`) and **Loss Red** (`loss`, `loss-soft`): money up or down, working or broken. **Online Green** (`online`), **Idle Amber** (`idle`) and **Away Grey** (`away`) are the presence dots.

### Night skin
Night redefines the `night-*` tokens over the same names (under `prefers-color-scheme: dark` unless the page forces light, and under a forced dark theme): deep indigo ground, opaque indigo panels, light ink, a darker grape title bar with a brighter deep grape for actions, a dark teal screen with light aqua ink, and lifted win, loss, bubblegum and blue. Lime, sun, online and idle are not redefined.

### Named Rules
**The Every Candy Has A Job Rule.** Grape is the app's chrome and its own actions, lime is mode and liveness, aqua is money, sun-yellow is away or waiting, bubblegum and blue are trader moves. A candy colour never appears as decoration outside its job.

**The Green Means Won Rule.** Win green and loss red mean money up or down, or a part working or broken. They are never used for branding, buttons or emphasis.

**The Same Candy At Night Rule.** The night skin changes ground, panels, lines, ink and grape depth only; the candy accents stay recognisably the same.

**Status-only colours.** `launch` labels new coins in the chat log (`night-launch` at night, so it stays readable on indigo). `live-red` is reserved for the real-money LIVE badge and nothing else. `disconnected` is the title bar's text colour while the live connection is down. The equity chart's "now" dot is `win` when the bag is at or above where it started, `loss` when below.

## Typography

**Display Font:** Pixelify Sans (with Rubik, monospace)
**Body Font:** Rubik (with system-ui, sans-serif)
**Label/Mono Font:** ui-monospace (with JetBrains Mono), for wallet addresses and raw machine text only

**Character:** A chunky pixel face for the one number that matters and the app's own name, against a round, friendly geometric sans for everything a person reads. The pixel face is the messenger era; Rubik keeps it legible at 13px.

Both faces are self-hosted variable woff2 files (latin subset, SIL OFL 1.1) so the app works offline.

### Hierarchy
- **Display** (Pixelify Sans 700, 74px, 46px under 860px, line-height 1): the bag figure on the aqua screen. One per page.
- **Wordmark** (Pixelify Sans 700, 17px): the app name in the title bar.
- **Badge** (Pixelify Sans 700, 13px, tracked 0.06em): the PAPER / LIVE mode badge.
- **Headline** (Rubik 700, 15px): panel titles, and the away message sentence (15px, regular, with a bold lead).
- **Title** (Rubik 700, 13px, Dusk Ink): sub-heads inside panels, often followed by a regular 12px muted aside.
- **Figure small** (Rubik 700, 16px, tabular): stat values under the bag screen; the delta line is 14px 700.
- **Body** (Rubik 400, 13px, line-height 1.45): everything else; tables and lists run at 12.5px.
- **Label** (Rubik 500, 12px, muted): stat labels, table headers, panel header asides, pills, chips.
- **Caption** (Rubik 500, 11.5px): presence lines, part details, times in the chat log; chart ticks are 10.5px.

### Named Rules
**The Pixel Is For Figures Rule.** Pixelify Sans appears on the bag figure, the wordmark and the mode badge only. It never sets a heading, a label or a sentence.

**The Tabular Money Rule.** Every number that can change (amounts, percentages, times, counts) uses tabular figures and right-aligns in tables.

## Layout

A fixed-chrome app layout tuned to 1366×768. A sticky 48px title bar, then the away message as a full-width strip (16px side margin), then a two-column shell: the tab content on the left and a 330px right rail on the right, 12px gap, 16px gutters. The rail (mini buddy list, then the live chat log filling the remaining height) is sticky below the title bar and visible on every tab; the mini buddy list hides on the buddies tab, where the full list is shown.

Home splits into two stacks (1.2fr and 1fr, the second at least 300px): the bag and the coins held on the left; "is it OK" with the data meter and limit control, then past trades, in the middle. The details tab is a two-column grid with a full-width row for the long trade table. Long tables scroll inside their panel (280px, or 196px for the short home version) with sticky headers instead of growing the page.

Spacing runs on a small 4 / 6 / 8 / 10 / 12 / 14 / 16 px rhythm: 12px between panels, 12px by 14px panel padding, 8 to 10px inside rows and controls.

At 1180px the rail drops below the content and stops being sticky. At 860px the title bar wraps with the tabs on their own scrollable row, every grid collapses to one column, the stat row goes to two columns, the bag figure drops to 46px and the long-trade table hides its least important columns.

## Elevation & Depth

Depth is frosted glass with a candy bevel: panels float over the glowing ground with translucency, a 14px backdrop blur (saturate 1.3), a white top border, an inset white top highlight, a faint inset bottom bevel and a soft two-layer drop. Everything inside a panel is flat: the bag screen, pills, rows and controls rely on tint and hairlines, not shadow.

### Shadow Vocabulary
- **Candy bevel** (`box-shadow: inset 0 1px 0 #fff, inset 0 -3px 0 rgba(28, 32, 110, .07), 0 1px 2px rgba(28, 32, 110, .10), 0 14px 30px rgba(28, 32, 110, .12)`): every panel and the online away strip. Night: `inset 0 1px 0 rgba(255, 255, 255, .08), inset 0 -1px 0 rgba(0, 0, 0, .25), 0 10px 28px rgba(0, 0, 0, .35)`.
- **Title bar edge** (`box-shadow: 0 1px 0 rgba(0, 0, 0, .12)`): a single hairline under the sticky title bar.
- **Tooltip lift** (`box-shadow: 0 8px 22px rgba(0, 0, 0, .18)`): chart tooltips only.

### Named Rules
**The One Layer Of Frost Rule.** Panels are the only frosted, shadowed layer. Nothing inside a panel gets its own drop shadow or blur.

**The Header Band Rule.** A panel's header sits on a faint grape band (6% grape; 4% white at night) with a soft-line bottom edge, flush to the panel's top corners.

## Shapes

Soft, nested corners that step down as elements get smaller: panels 16px, the away strip 14px, the bag screen 12px, tooltips and warn boxes 10px, inputs and buttons 9px, the mode badge 7px, checkboxes, meter tracks and bar tops 4px. Status-carrying elements (tabs, pills, chips, the away pill, memory tags, flags) are full pills. Presence dots and LEDs are circles (7px and 9px). Pixel art (the away face and the identicons) renders with crisp edges on an integer grid and is never smoothed; identicon tiles take a 22% corner radius with a 1px line ring. Disclosure arrows are drawn chevrons that rotate from right to down.

## Components

### Title Bar
Grape, 48px, sticky. Left to right: the lime PAPER badge (LIVE swaps to a red badge with white text), the pixel wordmark, the connection state with a live dot and a clock in white at 82%. Tabs are pill buttons in white at 86%, 14% white on hover; the selected tab is a solid white pill with Deep Grape text. At the end sit flag pills (16% white) and the voice switch, a white-outlined pill. Focus rings inside the bar are lime.

### Away Message (signature)
A full-width strip under the title bar that says how the bot is doing in one sentence. Left: the bot's 12×12 pixel face (green and smiling when online, grape with flat eyes when away, red and frowning when it needs the owner). Middle: a bold lead ("status:" / "away message:") plus the sentence, with a 12px line beneath ("all parts vibing · nothing needs you"). Right: a state pill. Away is the default skin (sun-soft fill, sun-line border, sun pill); online becomes a frosted panel with a green pill; busy turns loss-soft with a red pill. The region is polite-live so changes are announced.

### Panels
Frosted surface with a header band holding a 15px bold title and a 12px muted aside that truncates. Padding 12px by 14px. Panels never nest.

### The Bag Screen (signature)
Inside the money panel: an aqua screen with the pixel figure and its unit, a delta line (bold signed SOL and percent in win or loss colour, then a regular mood phrase in Dusk Ink), and a step chart: equity moves only when a trade closes, so the line is drawn in horizontal and vertical steps in ink, with a dashed screen-ink line at the starting amount and a dot at "now". Below the screen, a four-up stat list (12px muted label, 16px bold value, 11.5px note) divided by soft top rules, not boxes; a "more numbers" disclosure holds the rest. When the figure changes it flips in (0.6s); when a trade closes live the whole bag panel gets one messenger nudge (a 0.5s horizontal shake). Both are off under reduced motion.

### Buddy List (signature)
Traders as buddies. Each row: a pixel identicon (a symmetric 5×5 pattern on a 7×7 grid, one colour picked from the address out of grape, teal, bubblegum, amber, blue, green and red), then the shortened address in mono 12.5px semibold over a 11.5px presence line led by a dot (online green within the hour, idle amber within the day, away grey otherwise). Icon size follows rank: 40px for the best grade, 4px smaller per place, never under 22px (8px smaller again in the rail's mini list, where each row ends with a right-aligned bold return over a muted caption).

### Parts List
"Is it OK" as a list of the bot's parts: a 9px LED (online green, idle amber when stale, red when broken, deep grape when on schedule), the part's name in semibold, its state word in the matching colour, a right-aligned muted time, and an 11.5px muted detail line that truncates. Rows split by soft lines.

### Live Chat Log (signature)
The rail's feed reads like a messenger log: a 54px column of tabular times, a bold 11.5px lowercase speaker tag ending in a colon and coloured by event kind (launch grape, trader buy bubblegum, trader sell blue, our buy green, our sell deep grape, rejects and errors red, warnings sun-ink), then the text on one truncating line. Reasons hang below as an indented bullet list, raw data behind a "the deets" disclosure. New lines arrive with a 1.4s grape-mist fade. Filter chips above it are grape-mist pills with a faded count; the pressed chip is solid deep grape with white text.

### Pills and Memory Tags
Pills are 12px semibold full pills with a 7px leading dot: neutral (grape mist, away dot), ok (win-soft), warn (sun-soft), bad (loss-soft). Brain memory tags are smaller 10.5px bold pills without a dot: new (grape mist with deep grape text), locked in (win-soft), changed its mind (sun-soft), fading (soft line with muted text).

### Brain Checklist
The brain's nightly test is a checklist: 15px boxes with 4px corners and an away-grey border, filled online green with a drawn white tick when passed, the check's words, and a right-aligned semibold number.

### Meters
7px tracks in grape mist with 4px corners; the fill is deep grape, sun when warning, loss red when bad. A 12.5px semibold row above names it and states used / limit.

### Inputs and Buttons
Only the two daily-limit controls take input. A 92px number field (Frost Solid, line border, 9px corners, 13px semibold, spinners removed) sits in a row with a primary save button (deep grape fill, white text, grape on hover) and a secondary "back to normal" button (Frost Solid with a line border). Disabled buttons fade to 45%. Focus is a 2px deep grape outline. Messages and notes sit beneath at 12px.

### Tables
12.5px rows with 5px by 8px cells and soft-line dividers, a grape-mist hover, 12px muted headers on Frost Solid that stick while the table scrolls inside its panel. Numbers right-align and use tabular figures; failed rows go muted.

### Charts
Small, quiet SVG charts. Gridlines in soft line, 10.5px tabular ticks in muted (screen ink on the bag screen). Bar charts use deep grape bars with 4px rounded tops that turn bubblegum on hover. A hover crosshair and a Frost Solid tooltip (10px corners, tooltip lift) show exact values.

## Do's and Don'ts

### Do:
- **Do** put the bot's state in the away message first: one sentence, a pixel face and a state pill, coloured sun when away, frost when online, loss-soft when it needs the owner.
- **Do** keep money on the aqua screen with the pixel figure as the only display-size type on the page.
- **Do** build every new surface as a frosted panel (16px corners, sheen, 14px blur, candy bevel) with a grape header band, and keep its contents flat.
- **Do** give every trader a pixel identicon and a presence dot (online under 1 hour, idle under 24 hours, away beyond).
- **Do** use Rubik with tabular figures for every number except the bag figure.
- **Do** define colours as tokens and give each new token a night value; keep the candy accents unchanged at night.
- **Do** keep motion to state changes (figure flip, one nudge per closed trade, new-line fade) and switch it off under reduced motion.

### Don't:
- **Don't** add a KPI tile row, a hero equity chart or a dark trading-terminal look; stats are a divided list under the bag screen.
- **Don't** use neon hype, flashing candles or casino effects (PRODUCT.md).
- **Don't** set headings, labels or sentences in Pixelify Sans.
- **Don't** use win green or loss red for anything except money up or down and parts working or broken.
- **Don't** use aqua outside the bag screen.
- **Don't** put walls of tables up front; long tables live on the details tab or scroll inside their panel.
- **Don't** smooth or anti-alias the pixel art; faces and identicons render with crisp edges on an integer grid.
