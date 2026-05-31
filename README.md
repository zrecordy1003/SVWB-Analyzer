# ShadowverseWB Analyzer

[![GitHub Downloads (all releases)](https://img.shields.io/github/downloads/zrecordy1003/SVWB-Analyzer/total)](https://github.com/zrecordy1003/SVWB-Analyzer/releases)
[![GitHub Downloads (latest release)](https://img.shields.io/github/downloads/zrecordy1003/SVWB-Analyzer/latest/total)](https://github.com/zrecordy1003/SVWB-Analyzer/releases/latest)
[![GitHub Release (latest)](https://img.shields.io/github/v/release/zrecordy1003/SVWB-Analyzer)](https://github.com/zrecordy1003/SVWB-Analyzer/releases/latest)

ShadowverseWB Analyzer is a desktop companion app for Shadowverse: Worlds Beyond. It captures game
screenshots, recognizes match information with OpenCV and OCR, stores match records locally, and
provides dashboards for match history and deck analysis.

The app is built with Electron, React, MUI, OpenCV4NodeJS, Tesseract.js, Prisma, and SQLite.

## Features

- Automatic screenshot capture for the game window.
- Template matching for class, emblem, play order, mode, result, and battle-state signals.
- OCR for BP and CR-related values.
- Local match database with Prisma and SQLite.
- Match list, filters, tags, notes, and edit flows.
- Deck analysis and matchup summaries.
- HUD overlay with recent matches and live battle status.
- Runtime-safe storage under Electron `userData`, so the app does not need to write into the install directory.

## Current Status

High-priority stability and performance work has been implemented:

- Read-only install directory safety.
- Shared Prisma client usage.
- Reduced MatchList duplicate loading and N+1 IPC calls.
- Short-lived stats caches with write invalidation.
- Reused OCR worker lifecycle.
- Dynamic analyzer polling intervals.
- Window-size-aware recognition geometry.
- Partial anchor-aware recognition for high-risk mode/OCR/result areas.
- Smaller OpenCV production packaging.
- Unit and smoke tests for recognition, migrations, IPC flows, query plans, and stats cache.

Remaining high-risk work:

- Real gameplay validation.
- Screenshot fixture-based analyzer tests.
- Packaged app smoke testing.
- More query-plan coverage for ranked winrate, deck aggregation, and CR range queries.

See [docs/project-status-roadmap.md](docs/project-status-roadmap.md) for the full roadmap.

## Project Structure

```text
src/main/
  analyzer.ts                 Analyzer process orchestration
  forkedImageAnalyzer.ts       Main recognition/analyzer flow
  hud.ts                      HUD BrowserWindow setup
  paths.ts                    userData runtime paths
  manageCaptureTool.ts        Runtime capture tool copy/spawn logic
  db/                         Database initialization and shared Prisma client
  ipc/                        Main-process IPC handlers
  recognition/                Geometry, anchors, templates, matching helpers
  utils/                      Shared main-process utilities

src/renderer/src/
  components/                 Main application UI
  hudcomponents/              HUD overlay UI
  hooks/                      Renderer data hooks and caches
  map/                        Class/mode metadata

src/shared/
  types.ts                    Shared cross-process types

resources/
  migrations/                 Runtime SQLite SQL migrations
  templates/                  Recognition templates
  opencv/bin/                 Packaged OpenCV runtime DLLs

tests/
  recognition/                Recognition unit tests
  main/                       DB, IPC, query-plan, stats-cache tests
  analyzer/                   Analyzer fixture harness
  fixtures/analyzer/          Screenshot fixture manifest
```

## Runtime Data

Runtime writable data is stored under Electron `userData`, not under the installation directory.

Important runtime paths:

- Database: `userData/db/app.db`
- Capture images: `userData/capture/`
- Runtime capture tool: `userData/tools/`
- OCR/cache data: `userData`
- Analyzer debug samples: `userData/capture/debug-samples/` when `DEBUG_ANALYZER_SAMPLES=1`

This is intentional. Installed application folders can be read-only, especially under Windows
installer-managed locations.

## Development

### Requirements

- Node.js compatible with the project toolchain.
- pnpm.
- Windows is the primary target.
- OpenCV runtime files under `resources/opencv/bin`.
- `tools/svwb-capture-tool.exe`.
- `eng.traineddata.gz` for Tesseract OCR packaging.

### Install

```bash
pnpm install
```

### Run in development

```bash
pnpm dev
```

### Preview built output

```bash
pnpm start
```

## Quality Checks

Run the full local verification set before release-oriented changes:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
git diff --check
```

Useful individual commands:

```bash
pnpm test:watch
pnpm run typecheck:node
pnpm run typecheck:web
```

Current test coverage includes:

- Recognition geometry and ROI clamping.
- Anchor-aware ROI behavior.
- Template scaling cache behavior.
- Template matching and multi-scale fallback.
- Database migration smoke tests.
- IPC smoke flow tests.
- SQLite query-plan smoke tests.
- Stats cache versioning.
- Analyzer fixture manifest validation.

The analyzer fixture harness is ready, but real screenshot fixtures still need to be collected.

## Build

Build renderer/main/preload output:

```bash
pnpm build
```

Create an unpacked app for smoke testing:

```bash
pnpm build:unpack
```

Create a Windows installer:

```bash
pnpm build:win
```

Packaging includes:

- Built app output under `out/`.
- Prisma client and runtime resources.
- SQL migrations.
- Recognition templates.
- Capture tool.
- Required OpenCV runtime DLLs only.
- Tesseract trained data.

## Debugging

Enable verbose analyzer logs:

```bash
set DEBUG_ANALYZER=1
pnpm dev
```

Save low-confidence analyzer samples:

```bash
set DEBUG_ANALYZER_SAMPLES=1
pnpm dev
```

Debug samples are written to the runtime capture directory under `debug-samples`.

## Documentation

- [Project status and roadmap](docs/project-status-roadmap.md)
- [Performance improvement notes](docs/performance-improvement-notes.md)
- [Recognition optimization status](docs/recognition-optimization-status.md)
- [Telemetry and DAU plan](docs/telemetry-dau-plan.md)

## 中文說明

ShadowverseWB Analyzer 是一款 Shadowverse: Worlds Beyond 桌面輔助工具。它會擷取遊戲畫面，
透過 OpenCV 模板比對與 Tesseract OCR 辨識對戰資訊，將紀錄儲存在本機 SQLite 資料庫，並提供
對戰列表、牌組分析、統計圖表與 HUD overlay。

### 主要功能

- 自動擷取遊戲畫面。
- 辨識職業、徽章、先後攻、模式、勝敗與對戰狀態。
- OCR 辨識 BP / CR 相關數值。
- 使用 Prisma + SQLite 儲存本機對戰紀錄。
- 支援對戰列表、篩選、標籤、備註與編輯。
- 提供牌組分析與對局統計。
- 提供 HUD overlay 顯示近期對戰與即時對戰狀態。
- 執行期資料寫入 Electron `userData`，避免安裝目錄唯讀時失敗。

### 目前狀態

目前高優先級的穩定性、效能與測試基礎已完成一大段，但還不能視為完全完成。剩餘重點是：

- 收集真實遊戲截圖 fixture。
- 補上 analyzer fixture image tests。
- 做 packaged app smoke test。
- 實機驗證辨識流程、HUD 更新與打包資源。

完整後續清單請看 [docs/project-status-roadmap.md](docs/project-status-roadmap.md)。
