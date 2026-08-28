# Telemetry and DAU Plan

This document records the proposed analytics direction for DAU and product usage metrics.

## Goals

- Understand daily active users.
- Understand which features are used.
- Detect capture/OCR/analyzer failure trends.
- Avoid collecting gameplay content or personally identifiable data.

## Privacy Principles

- Telemetry must be opt-in by default.
- Users must be able to disable telemetry from Settings.
- Do not send screenshots, OCR raw text, deck names, local file paths, match history, or opponent details.
- Use an anonymous install id only after telemetry is enabled.
- Do not link the install id to GitHub, Discord, Steam, OS username, or any account identity.
- Network failures must never affect app behavior.

## Minimal Events

Recommended MVP events:

- `app_start`
- `app_shutdown`
- `capture_started`
- `capture_failed`
- `analyzer_started`
- `match_recorded`
- `deck_analysis_opened`
- `deck_analysis_filter_changed`
- `ocr_failed`

## Shared Event Properties

Safe properties:

- `app_version`
- `platform`
- `arch`
- `locale`
- `is_packaged`
- `event_schema_version`

Avoid:

- screenshots
- OCR output
- deck names
- match notes
- tags
- local paths
- complete match records

## DAU Identity

DAU requires a stable anonymous identifier.

Recommended local keys:

- `settings.telemetryEnabled`: boolean, default false.
- `telemetry.installId`: random UUID generated only after telemetry is enabled.

If telemetry is disabled:

- Stop sending events.
- Keep or delete `telemetry.installId` depending on the product choice; deleting is more privacy-friendly.

## Suggested Architecture

```text
main process telemetry.ts
  -> track(eventName, props)
  -> in-memory queue
  -> debounce/batch
  -> HTTPS analytics endpoint
```

Implementation notes:

- Keep telemetry in the main process, not scattered across renderer components.
- Renderer should call typed preload APIs if it needs to track UI usage.
- Track only coarse feature usage and operational health.
- Batch events to reduce network overhead.
- Drop old queued events after a small limit.

## Provider Options

### Plausible

Good first choice for a small app:

- Simple Events API.
- Stats API can query aggregates.
- Privacy-friendly positioning.
- Low SDK footprint if using direct HTTP events.

Docs:

- https://plausible.io/docs/events-api
- https://plausible.io/docs/stats-api

### PostHog

Good if deeper product analytics are needed:

- Event analytics, funnels, retention, feature usage.
- More powerful but heavier event model.
- Be careful with anonymous distinct id behavior.

Docs:

- https://posthog.com/docs/libraries/js

### OpenTelemetry

Better for technical observability than DAU:

- App startup timing.
- Error traces.
- DB/query timings.
- Main-process performance.

Docs:

- https://opentelemetry.io/docs/languages/js/getting-started/nodejs/

## Recommended MVP

1. Add Settings UI copy for telemetry opt-in.
2. Add `src/main/telemetry.ts`.
3. Add typed preload API for renderer usage events.
4. Track `app_start`, `match_recorded`, `deck_analysis_opened`, `capture_failed`, and `ocr_failed`.
5. Use Plausible Events API or a small custom endpoint first.
6. Review actual event volume and dashboard usefulness before adding more events.
