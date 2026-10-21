---
version: 1
slug: "dashboard-static-index-html"
primary_target: "dashboard/static/index.html"
related_targets: ["dashboard/static/app.js","dashboard/static/style.css","dashboard/static/genz.js"]
---

# Dashboard app (dashboard/static)

Scope: the bot's desktop dashboard app (GTK WebKit window, also a local browser page). Visitor mode: Operate. Owner checks it a few times a day for about a minute; first question "am I winning or losing", then "is everything OK", then "what is it doing", then "what did the brain learn". Must not feel casino, spreadsheet, plain, or un-Gen-Z. Keep every existing panel, the plain / Gen Z switch, the two daily-limit controls, live SSE updates, and compactness on a 1366×768 screen.

## Direction contract

THESIS: The bot is online like a 2003 messenger buddy. One away message tells you how it's doing, the traders we copy are its buddy list, the bag lives on a frosted status screen. Refuses the category default: KPI tile row, equity chart, dark trading terminal.

OWN-WORLD: Icy periwinkle ground with frosted translucent white panels and soft candy bevels (inset top highlight, soft drop). Grape title bar, lime "PAPER" badge, aqua status screen for money, bubblegum and sun-yellow for idle/away states. Pixelify Sans only on big figures and the app name; Rubik for everything else. Pixel identicon avatars per trader. Night skin: deep indigo ground, same candy accents.

STORY: Open the app, read the away message (status in one sentence), see the bag figure and W/L on the aqua screen, glance at the buddy list and the chat-log live tea, tab to buddies / the brain / nerd stuff for depth, change a daily limit with confirmation.

FIRST VIEWPORT: Grape title bar (badge, name, live clock, tabs: home, buddies, the brain, nerd stuff; voice switch). Away message strip under it, full width. Home: bag status screen left (figure ~64px pixel type, delta line, step chart, stat list), middle column "is it OK" + coins we hold + past trades, right rail live tea chat log with filter chips, always visible on every tab.

FORM: Y2K messenger (AIM / MSN buddy list, away message, nudge), candidate 7 of 7 on the grounded list. Signature move: the away message plus buddy list (online < 1h, idle < 24h, away), buddy icon size by grade; a one-time MSN-style nudge of the bag screen when a trade closes live. Seed key c23bb2ba.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
