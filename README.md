# optArb

Система арбитража крипто-опционов между биржами **Deribit**, **Binance Options**, **Bybit**, **OKX** и бинарными контрактами **Polymarket** (моделируются как цифровые опционы). Активы v1: BTC, ETH. Стек: Node.js 22 + TypeScript, pnpm-монорепозиторий.

**Статус:** стадия дизайна. Архитектурные решения — в [`docs/adr/`](docs/adr/README.md).

## Документация

| Документ | Содержание |
|---|---|
| [docs/adr/README.md](docs/adr/README.md) | Индекс и процесс ведения ADR |
| [ADR-0001](docs/adr/0001-goals-and-scope.md) | Цели, границы, метрики |
| [ADR-0002](docs/adr/0002-technology-stack.md) | Стек: Node.js + TypeScript |
| [ADR-0003](docs/adr/0003-exchange-connectivity.md) | Нативные коннекторы к 5 площадкам |
| [ADR-0004](docs/adr/0004-system-architecture.md) | Модульная архитектура, поток данных, replay |
| [ADR-0005](docs/adr/0005-data-storage.md) | Redis + Postgres + JSONL-capture |
| [ADR-0006](docs/adr/0006-risk-and-execution-safety.md) | Риск-менеджмент, kill switch, paper-first |

## Идея в двух словах

Ликвидность опционов фрагментирована: Deribit котирует премии в BTC, Binance — в USDT, Bybit — в USDC, OKX — в USD, а Polymarket продаёт бинарные контракты «BTC > X к дате D», которые оцениваются как цифровые опционы (`N(d2)` / репликация call-spread). После нормализации к USD-нотионалу между площадками систематически возникают расхождения — система собирает real-time данные, детектирует edge с учётом комиссий и leg-риска и исполняет двухногие сделки под жёсткими лимитами (paper-first).

## Работа с kimi-code

Проект настроен для AI-агента [kimi-code](https://moonshotai.github.io/kimi-code/):

- **`AGENTS.md`** (корень) — главная инструкция агенту: стек, правила кодирования, безопасность, чек-лист. Загружается автоматически; действует иерархически (можно класть дополнительные `AGENTS.md` в подкаталоги)
- **Скиллы проекта** — `.kimi-code/skills/` (project-scope, высший приоритет):

  | Скилл | Вызов | Назначение |
  |---|---|---|
  | `exchange-connectors` | `/skill:exchange-connectors` | Эндпоинты, WS-каналы, heartbeat, auth, quirks всех 5 площадок |
  | `trading-domain` | `/skill:trading-domain` | Опционы, греки, IV, parity, цифровики, типы арбитража |
  | `adr` | `/skill:adr <название>` | Процесс ведения ADR |
  | `release-review` | `/skill:release-review` | Ревью кода + diff-анализ + push в GitHub только после одобрения |

  Агент может вызывать их и сам (по `whenToUse`), не только через slash-команду.

### Что kimi-code поддерживает / не поддерживает

- **Суб-агенты**: только встроенные `explore` (read-only исследование), `plan` (планирование), `coder` (реализация) — главный агент диспетчеризует их автоматически. Пользовательских суб-агентов создавать нельзя → расширение поведения делается **скиллами**
- **Скиллы**: 4 уровня приоритета Project (`.kimi-code/skills/`, `.agents/skills/`) > User (`~/.kimi-code/skills/`, `~/.agents/skills/`) > Extra (`extra_skill_dirs` в `~/.kimi-code/config.toml`) > Built-in. Формат — `SKILL.md` с YAML-frontmatter (`name`, `description`, `whenToUse`, `type: prompt|flow`, `arguments`)
- **Локальный конфиг проекта**: `.kimi-code/local.toml` (создаётся CLI, в `.gitignore`)
- **Внешние скиллы**: для Polymarket есть готовый community-скилл LobeHub `web3-polymarket` (auth, ордера, CTF, bridge) — при желании установить в `~/.kimi-code/skills/`
- **Прочее**: поддерживаются MCP-серверы, hooks и plugins (`plugin.json`) — пока не используются

## Безопасность

- Paper-режим по умолчанию; live — только `LIVE_TRADING=true` + подтверждение оператора (ADR-0006)
- Секреты только через env; в репозитории — `.env.example`
- Все ордера проходят pre-trade риск-проверки; kill switch глобальный и по-площадочный

## Следующие шаги

1. ✅ Git: `origin` → https://github.com/tera1oo4/optArb.git (ветка `main`); push — только после ревью и diff-анализа (`/skill:release-review`)
2. ✅ Scaffolding pnpm-workspaces: `packages/{core,persistence,venues/deribit}`, `apps/{collector,backtest}`; 22 теста, typecheck+prettier зелёные
3. ✅ Коннектор Deribit (testnet): WS + heartbeat + reconnect + book resync + capture → replay через тот же pipeline (`pnpm dev:collector`, `pnpm backtest <file>`)
4. ✅ Коннекторы Bybit (testnet), OKX (demo), Binance (prod read-only): общий `BaseWsConnector` + `L2Book` в core; multi-venue collector (`VENUES=...`) и multi-venue replay; 53 теста; smoke: все 4 биржи live, 0 gaps на replay
5. ✅ `packages/marketdata` (USD-нормализация, consolidated view) + `packages/signals` (cross-venue детектор) + `apps/trader` paper: live-проверено — сигналы Deribit-testnet × OKX-prod; 64 теста
6. ✅ Polymarket connector (read-only) + `packages/pricing` (Black-76, digital) + детекторы digital-vs-vanilla и YES/NO-parity в `packages/signals`

### Polymarket → каноническая модель (M3)

- Бинарный рынок «Will BTC be above $K on date D?» → **два инструмента** `kind: 'binary'`: YES-токен = цифровой **call**, NO-токен = цифровой **put** на один strike (underlying из вопроса, expiry из Gamma `endDate`, strike — regex из текста вопроса); пара связана общими canonical-частями, `conditionId` лежит в `Instrument.metadata`
- Цены 0–1 USDC за share (payoff $1); binary-инструменты живут в отдельном key-неймспейсе `binary:` consolidated view — их цены никогда не смешиваются с премиями vanilla-опционов в cross-venue детекторе
- Touch-рынки («reach $X», «dip to $X») и up/down — **не** expiry-диджиталы: регистрируются со `strike: null` + `metadata.parseable: 'false'`, view не создаётся, pricing/детекторы их пропускают
- CLOB market WS: subscribe `{"assets_ids":[...],"type":"market"}`, heartbeat клиентский `{}` каждые 10с; sequence нет — snapshot replace + level-дельты

> Известное ограничение окружения: Bybit/Binance блокируют US-egress (403/451); OKX demo-книги пустые — для сигналов OKX используется prod read-only
