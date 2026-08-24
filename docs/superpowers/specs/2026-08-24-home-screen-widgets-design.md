# Home-Screen Reading Widgets — Design

**Date:** 2026-08-24
**Status:** Draft
**Scope:** Android (AppWidget) + iOS (WidgetKit) home-screen widgets for Readest

## 1. Goals

Give readers glanceable, zero-open access to their reading life via three
focused widgets they compose themselves on the home screen:

1. **Continue Reading** — resume the book they were last reading
2. **Reading Streak** — a daily habit signal (streak count, minutes today)
3. **Next in Series** — one-tap continuation for comic/manga readers
   (the fork's signature use case)

Widgets render from a precomputed snapshot store; they never query the app's
library database or read EPUB data at render time.

## 2. Non-goals (v1)

- TTS transport controls on the widget (upstream has these; deferred)
- Configurable widget options UI (book picker, theme override)
- Medium/Large iOS families and Android resizable layouts beyond Small
- Interactive elements beyond tap-to-deep-link (no buttons that mutate app
  state from the widget)

## 3. Widget specifications

All three widgets ship as separate pickers entries: three `AppWidgetProvider`s
on Android, three Widgets in one `ReadestWidgets` WidgetKit bundle on iOS.
v1 size is Small (Android 2×2 resizable 1×1–3×2; iOS `.systemSmall`).

### 3.1 Continue Reading

| Aspect | Behavior |
|---|---|
| Content | Cover image, book title (≤2 lines, ellipsized), chapter label or %, progress bar, % badge |
| Data | The most recently *opened* in-progress book (highest `updatedAt` among books with `0 < progress < 100`) |
| Tap | Deep link `readest://book/{bookHash}` — opens the reader, resuming in place if already open |
| Empty state | "Open a book to start reading" + app icon; tap opens the Library |

### 3.2 Reading Streak

| Aspect | Behavior |
|---|---|
| Content | Flame glyph + streak day count ("12 days"), minutes read today, a 7-day mini bar row |
| Data | Computed from the daily stats recorder (§6): consecutive local calendar days with ≥60 active seconds ending today-or-yesterday |
| Tap | Opens the Library |

### 3.3 Next in Series

| Aspect | Behavior |
|---|---|
| Content | Series cover, series title, "Vol. N finished", "Start Vol. N+1" pill |
| Eligibility | Reuses the existing next-volume detection (`libraryUtils.ts` / `NextVolumePill.tsx` logic): most recent finished book whose sibling volume exists in the library |
| Tap | Whole tile deep-links into the next volume's book hash |
| Empty state | "No series in progress"; tile renders dimmed and non-prominent; tap opens the Library (same as Continue Reading's empty state) |

## 4. E-ink style variant

A single boolean rides in every snapshot: `style: "default" | "eink"`.

- Setting: **Settings → Misc → "E-ink style widgets"**, defaulting to ON when
  the app's e-ink mode (`[data-eink]`) is enabled at publish time.
- Providers select a flat palette resource set: no gradients/shadows, solid
  `#111` text on white, crisp 1px borders around covers and tiles.
- No second layout set — same RemoteViews/SwiftUI hierarchy, different color
  and drawable resources selected by the flag.

## 5. Architecture

```
┌─ Frontend (TypeScript) ───────────────────────────────────────┐
│  src/services/widgets/widgetService.ts                        │
│   • builds WidgetSnapshot from library/progress stores        │
│   • debounced publish (see §7)                                │
│   → invoke('update_reading_widgets', { snapshot })            │
│                                                               │
│  src/services/stats/dailyStats.ts                             │
│   • records active reading seconds per local day (§6)         │
└───────────────┬───────────────────────────────────────────────┘
                ▼
┌─ tauri-plugin-native-bridge (existing plugin) ───────────────┐
│  Rust command update_reading_widgets(snapshot: String)       │
│   → forwards to platform implementation                      │
│                                                              │
│  Android (Kotlin)                                            │
│   • ReadingWidgetStore: writes snapshot JSON to              │
│     SharedPreferences ("reading_widgets"), downsized cover   │
│     PNGs (~256px) to cacheDir/widget-covers/                 │
│   • ReadingWidgetProviders.kt: three AppWidgetProviders      │
│     rendering RemoteViews from the store                     │
│   • AppWidgetManager.updateAppWidget(...) per provider       │
│                                                              │
│  iOS (Swift)                                                 │
│   • NativeBridgePlugin writes snapshot JSON + cover files    │
│     into the App Group container                             │
│   • WidgetCenter.shared.reloadAllTimelines()                 │
│   • New ReadestWidgets extension target (XcodeGen entry in   │
│     gen/apple/project.yml), 3 TimelineProviders; App Group    │
│     entitlement added to BOTH main app and extension targets  │
└───────────────┬───────────────────────────────────────────────┘
                ▼
   Widgets render exclusively from the persisted store.
   If the app process is dead, widgets still show the last snapshot.
```

Component boundaries:

- **widgetService.ts** — pure-ish: snapshot builder (unit-testable given
  library/progress/streak inputs) + publisher (side effects). Owns debounce.
- **dailyStats.ts** — owns the daily seconds map; exposes `recordTick(sec)`,
  `getStreak()`, `getMinutesToday()`. No knowledge of widgets.
- **ReadingWidgetStore (Kotlin) / store (Swift)** — dumb persistence +
  cover-file management. No business logic.
- **Providers (Kotlin/Swift)** — pure view mapping from stored snapshot to
  RemoteViews / SwiftUI views. No I/O beyond reading the store.

## 6. Daily stats recorder

The fork has no reading-time tracking today; this is the minimal recorder
that makes the streak widget possible (and seeds future stats features).

- A reader session hook accumulates **active** seconds (page visible,
  reader open, user not idle >60s without page interaction) into the current
  local calendar day.
- Persistence: rolling map `{ "2026-08-24": 2580, ... }`, kept for 60 days,
  stored via `SettingsManager` under a single `reading.dailyStats` key
  (~60 short entries ≈ 1–2 KB JSON — well within existing settings payloads).
- Flush cadence: every 30s of accumulated time and on reader close (crash-
  safe: losing ≤30s of data is acceptable).
- Streak definition: consecutive days ending today (or yesterday if today has
  no time yet) with ≥60 recorded seconds.

## 7. Snapshot & update policy

```jsonc
{
  "version": 1,
  "publishedAt": 1756000000000,
  "style": "eink",
  "continueReading": {
    "hash": "…", "title": "Kafka on the Shore",
    "progressPct": 62, "chapterLabel": "Ch. 24",
    "coverFile": "kafka.png"
  },
  "streak": { "days": 12, "minutesToday": 43, "week": [21,18,0,35,40,12,43] },
  "nextInSeries": { "series": "Berserk", "finishedLabel": "Vol. 41 finished",
                    "nextHash": "…", "nextLabel": "Vol. 42", "coverFile": "berserk.png" }
}
```

Publish triggers (debounced 5s, coalesced):

- reader progress change, throttled to ≥60s intervals
- book open / close
- book added, finished, or deleted (library change events)
- daily-stats flush crossing a day boundary (midnight rollover)
- e-ink style setting changed

Covers are written once per book hash (content-hash filename) so unchanged
books don't rewrite bitmaps.

Ordering: `week[6]` is today; indexes 0–5 are the six preceding days.
The ≥60s progress throttle applies *before* the 5s debounce coalescer, so a
burst of progress events yields at most one publish per minute.

## 8. Error handling & edge cases

| Case | Behavior |
|---|---|
| Library empty / no in-progress book | Empty states per §3; providers always render something (Android requirement) |
| Cover decode failure or file missing at render time (e.g. Android cacheDir eviction) | Provider falls back to a generated letter-cover placeholder until the next publish rewrites it |
| Snapshot JSON corrupt/unreadable | Store treats as absent → widgets render empty states; next publish heals |
| iOS App Group unavailable (dev build) | Swift store logs and no-ops; widgets show placeholder timeline |
| Day flips while device off | Streak computed from the map at publish time; midnight rollover trigger also fires on first reader activity after date change |
| Clock/timezone changes | Days keyed by local calendar date; streak recomputes fully each publish (no incrementally-maintained state to corrupt) |
| Multiple devices | Stats are device-local in v1 (no sync); documented as such |

## 9. Testing

- **Unit (vitest)**: snapshot builder (ordering, filtering, empty inputs),
  streak calculator (gaps, today-vs-yesterday edge), dailyStats flush logic
- **Kotlin**: `ReadingWidgetStoreTest` (JSON round-trip, corrupt input,
  cover file reuse) following the repo's existing androidTest pattern
- **Manual/device matrix**: widget add/remove/update on Android launcher
  (pixel launcher + e-ink device), iOS small widget, deep links cold vs warm
- **CI**: unit tests run in existing PR checks; Kotlin tests in the android
  unit-test lane

## 10. Open questions

- None blocking. Deferred to v2 consideration: Medium/Large sizes, TTS
  controls, stats sync across devices, widget configuration intents.
