# AGENTS.md — optArb

Инструкции для AI-агентов (kimi-code и др.), работающих с этим репозиторием.

## О проекте

**optArb** — система арбитража крипто-опционов между биржами **Deribit, Binance Options, Bybit, OKX** и бинарными контрактами **Polymarket** (которые моделируются как цифровые опционы). Активы v1: BTC, ETH.

Архитектурные решения зафиксированы в [`docs/adr/`](docs/adr/README.md) — **читай релевантные ADR перед изменениями** и не нарушай принятые решения. Новое значимое решение → новый ADR (см. `/skill:adr`).

## Технологический стек (ADR-0002)

- Node.js 22 LTS, TypeScript 5 (`strict`), ESM
- pnpm workspaces — модульный монолит
- vitest, eslint + prettier, zod, pino, ws
- **decimal.js / fixed-point bigint для всех цен и количеств — `number`-float в финансовых расчётах запрещён**
- Время: epoch ms UTC; `Date.now()` только через интерфейс `Clock` (ADR-0004)

## Структура (ADR-0004)

```
packages/core             — доменная модель, EventBus, Clock, CaptureSink, L2Book, BaseWsConnector
packages/persistence      — JSONL capture + replay reader; Postgres audit writer + migrations (optional); Redis hot-state store (books, portfolio, metrics, kill switch)
packages/venues/deribit   — Deribit WS (testnet/prod)
packages/venues/bybit     — Bybit V5 option WS (testnet/prod)
packages/venues/okx       — OKX V5 option WS (demo/prod; REST требует browser User-Agent)
packages/venues/binance   — Binance options: fstream (markPrice + diff depth + trades, prod read-only)
packages/venues/polymarket — Polymarket CLOB (read-only): Gamma REST discovery + market WS; YES=digital call, NO=digital put
packages/marketdata       — USD-нормализация (coin-quoted × index), consolidated view (canonical key; binary-инструменты в неймспейсе `binary:`)
packages/signals          — cross-venue детектор + digital-vs-vanilla + YES/NO-parity (freshness + spread bps + executable size)
packages/execution        — paper-only execution: OMS two-legged state machine + leg-risk control (M9),
                            fee-aware virtual fills, positions, PnL (NO order APIs)
packages/risk             — pre-trade risk engine: limits, quote freshness, edge-after-fees, kill switch (env fallback + runtime callback)
packages/venues/all       — meta-пакет: фабрика createVenueConnector для apps
packages/pricing          — Black-76 (call/put), normalCdf, digital call/put = DF·N(±d2); decimal.js only
packages/backtest-engine  — deterministic replay: marketdata → signals → risk → paper execution → PnL report
packages/analytics        — performance analytics: hit-rate, PnL curves, per-detector/per-venue attribution from audit/trade-log data
apps/collector            — live-сбор рыночных данных + capture (multi-venue, VENUES=...)
apps/backtest             — thin CLI over packages/backtest-engine (multi-venue replay)
apps/analytics            — CLI for Postgres-backed performance reports
apps/trader               — paper-режим: consolidated view + cross-venue сигналы (ордеров НЕТ)
```

## Команды

```bash
pnpm install            # установка зависимостей (pnpm 11: allowBuilds для esbuild уже в pnpm-workspace.yaml)
pnpm build              # typecheck всех пакетов
pnpm test               # vitest (unit)
pnpm lint               # tsc --noEmit + prettier --check
pnpm format             # prettier --write
pnpm dev:collector      # сбор рыночных данных + capture (env: VENUES=deribit,bybit,okx,binance,polymarket)
pnpm dev:trader         # paper-режим: consolidated view + cross-venue сигналы
pnpm backtest <file>    # replay capture-файла
pnpm analytics --from 2026-07-01 --to 2026-07-08 --output json|csv|table  # Postgres-backed performance report
pnpm --filter @optarb/persistence migrate  # apply Postgres migrations (needs PERSIST_POSTGRES_URL)
```

### Venue-специфика (важно)

- Deribit: testnet по умолчанию; IV в процентах → делится на 100 в парсере; interval-каналы (.100ms) шлют полные snapshot'ы книги
- Bybit: testnet по умолчанию; heartbeat `{"op":"ping"}` 20s; IV — доля; orderbook delta: `u === prevU+1`, иначе resync; **multiplier 1 BTC не отдаётся API** — конфиг `contractMultiplier` (эмпирика 2026-07-11); testnet шлёт orderbook-снапшоты только для depth 25
- OKX: demo по умолчанию (`x-simulated-trading: 1`, wspap), но **demo-книги мёртвые** (нет двусторонних котировок) — для сигналов нужен prod read-only (`OKX_DEMO_TRADING=false`, `OKX_WS_URL=wss://ws.okx.com:8443/ws/v5/public`); REST требует browser User-Agent (Cloudflare 403); heartbeat — сырой текст `ping`/`pong`; books5 — полный top-5 каждый пуш; multiplier = ctVal×ctMult (0.01 BTC); **премии котируются в coin** (bidPx 0.017 = BTC, не USD!); `tickers` = только bid/ask/last; index — канал `index-tickers`, markPx — канал `mark-price`; IV/греки недоступны на public WS (opt-summary REST-only) → markIv/greeks = null; demo-инструменты фильтруются по `instFamily === uly`
- **Гео-блоки**: Bybit (CloudFront 403 «block access from your country») и Binance (HTTP 451) блокируют US-egress; Deribit testnet и OKX prod доступны. REST-ошибки включают тело ответа (`assertHttpOk` в core) — гео-блок виден сразу
- Binance: testnet для опционов **не существует** — только prod public read-only; старый `nbstream/eoptions` снят (404), стримы на `fstream.binance.com`: markPrice на `/market/stream`, depth/trades на `/public/stream`; символы в stream-именах **lowercase**; depth — futures-style diff (pu-цепочка), REST `/eapi/v1/depth` отстаёт → rebase-модель (replace + новая цепочка); один `{uly}usdt@optionMarkPrice` покрывает тикеры+греки всего рынка
- Polymarket: testnet **не существует** — prod mainnet public read-only; discovery через Gamma REST (`/markets`, pagination limit+offset; `outcomes`/`clobTokenIds` — JSON-строки); WS `wss://ws-subscriptions-clob.polymarket.com/ws/market`, subscribe `{"assets_ids":[...],"type":"market","custom_feature_enabled":true}`, **heartbeat клиентский `{}` каждые 10с** (без него отключение ~30с); сообщения могут приходить массивом событий; sequence **нет** (`hash` — dedup-маркер) → snapshot replace + level-дельты (size "0" = удаление); цены 0–1 USDC за share (payoff $1); YES-токен = digital call, NO = digital put (canonical parts одинаковые, `conditionId` в metadata); парсинг вопросов намеренно поверхностный — strike только у "above $X", touch-рынки (reach/dip) → `parseable: 'false'` + strike null

## Правила кодирования

- TypeScript strict, без `any`; внешние payloads (WS/REST бирж, env) — через zod-схемы
- Коннекторы реализуют `VenueConnector` из `packages/core`; метаданные инструментов грузятся из API биржи, **не хардкодятся** (ADR-0003)
- Каждый коннектор: reconnect + backoff, heartbeat по правилам площадки, контроль sequence книги, capture сырых сообщений
- Логирование только через pino, структурированно; секреты/подписи/ключи в логах запрещены (redaction)
- Публичный API пакета — только `index.ts`
- Код, комментарии, имена, коммиты — на **английском**; общение с пользователем — на **русском**

## Тестирование

- Unit-тесты vitest для pricing/signals/risk — обязательны
- Replay-тесты: сценарии из capture-файлов (включая «всё пошло не так»: разрыв sequence, потеря heartbeat, reject биржи)
- Интеграция с биржами — только testnet/paper-ключи (ADR-0006)

## Безопасность (ADR-0006) — нерушимо

- **Никогда не отправлять реальные ордера** из тестов, скриптов и dev-сессий; live требует `LIVE_TRADING=true` + явного подтверждения оператора
- Секреты только через env; в репозитории — только `.env.example`; `.env` в `.gitignore`
- Любой ордер проходит через пакет `risk`; обход запрещён
- При работе с Polymarket: приватный ключ не выводить, не логировать, не коммитить

## Git workflow — GitHub

- Репозиторий: `origin` → https://github.com/tera1oo4/optArb.git, основная ветка `main`
- **Жёсткое правило:** никаких `commit`/`push` без (1) code review по чек-листу, (2) diff-анализа, показанного пользователю, (3) явного подтверждения пользователя. Полный процесс — `/skill:release-review`
- Любая git-мутация (commit, push, reset, rebase, amend, force-push) — только с подтверждением пользователя на каждое действие
- Коммиты на английском, conventional commits (`feat(venues): ...`, `docs(adr): ...`), ссылка на ADR-XXXX когда применимо
- Запрещено: force-push, `--no-verify`, коммит секретов / `.env` / capture-данных / `node_modules` / `.kimi-code/local.toml`
- Повышенное внимание при ревью изменений в `packages/execution`, `packages/risk`, `packages/venues/*` — код влияет на реальные деньги
- Если в working tree есть незакоммиченные изменения и задача завершена — предложи пройти `/skill:release-review`

## Среда kimi-code

- **AGENTS.md** действуют иерархически: этот файл (корень) + файлы в подкаталогах при наличии
- **Скиллы проекта** (`.kimi-code/skills/`, вызов `/skill:<name>`):
  - `exchange-connectors` — эндпоинты, WS-каналы, heartbeat, аутентификация и quirks всех 5 площадок
  - `trading-domain` — опционы, греки, IV, put-call parity, цифровые опционы, типы арбитража
  - `adr` — процесс ведения Architecture Decision Records
  - `release-review` — ревью кода + diff-анализ + push в GitHub только после одобрения пользователя
- **Суб-агенты**: встроенные `explore` (read-only исследование), `plan` (планирование), `coder` (реализация). Пользовательских суб-агентов kimi-code не поддерживает — расширение делается скиллами
- `.kimi-code/local.toml` — локальный конфиг, в `.gitignore`, не коммитить

## Чек-лист перед завершением задачи

1. `pnpm test` и `pnpm lint` зелёные (когда scaffolding будет готов)
2. Изменённые решения отражены в ADR / AGENTS.md
3. Никаких секретов, ключей, реальных ордеров в коде и логах
