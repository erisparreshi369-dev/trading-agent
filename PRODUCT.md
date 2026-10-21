# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One owner, non-technical, who prefers a Gen Z voice. They run a pump.fun copy-trading bot on their own Linux Mint laptop (1366×768 screen) and check the dashboard app a few times a day: open it, look around for about a minute, close it. Telegram texts carry the urgent news; the app is where they look at the bigger picture.

## Product Purpose

A bot that copies the buys of the best-scoring pump.fun traders, in practice mode (pretend money, 1 SOL start) until the owner decides otherwise. The dashboard app answers, in this order: am I winning or losing; is everything OK; what the bot is doing right now; what its learning brain has learned and remembers. Success is the owner understanding where things stand within a minute, without decoding jargon.

## Positioning

It is the owner's own bot, not a trading terminal: it copies traders it graded itself, skips what its checks or its learning brain distrust, and explains itself in plain or Gen Z words. Every number shown is the bot's own record (paper trades, skipped chances, what following would have made), never market hype.

## Operating Context

- Desktop app: a GTK + WebKit window (dashboard/app.py) around the local page served on http://localhost:8080 (dashboard/server.py), live over Server-Sent Events. Also opens in a normal browser on the same machine. Loopback only.
- Telegram is the companion channel: alerts, /status, /pnl, /why, /brain, in the same voice.
- Parts of the bot: data collector, trader, texter (Telegram notifier), learning brain (nightly study 00:40 UTC), wallet scoring (00:15 UTC), MadeOnSol helper job (00:02 UTC), weekly report (Sundays).
- Free data budget: Helius 1500 MB a day by default; when used up, copying pauses until 00:00 UTC.

## Capabilities and Constraints

- View-only except two daily limits the owner may change (Helius daily data limit, MadeOnSol job stop %), with confirmation and a Telegram notice.
- Voice switch: Gen Z (default, from config notifier.voice) or plain, remembered per viewer.
- Practice mode only; LIVE trading is set only by the owner, never from the app. Risk limits are hardcoded.
- Everything is kept forever (no data deletion); the brain remembers every lesson.
- Terminology the owner knows: the bag, W/L, coin, our traders, chance to copy, skipped, practice mode, emergency stop, data limit, the brain.

## Brand Commitments

- Gen Z voice by default ("the tea", "W", "lowkey sus", "your move"), with a plain switch. Must feel like the owner's bot, not a bank app.
- Not casino or crypto-bro: no neon hype, no flashing candles.
- Not a spreadsheet: no walls of tables or jargon up front.

## Evidence on Hand

Real data only, from data/trading.db: paper trades, signals and skip reasons, wallet scores, data usage, brain models, lessons and memory. Nothing may be invented in the app.

## Product Principles

1. Money first: W/L and the bag answer the first question at a glance.
2. Explain, don't decode: every number comes with words a non-trader understands.
3. Calm when fine, loud only when something needs the owner.
4. Its own voice: playful Gen Z tone, but the facts stay exact.
5. Details on demand: deep tables and raw numbers sit one step away, not up front.
