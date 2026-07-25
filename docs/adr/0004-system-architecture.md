# ADR-0004: Модульная архитектура системы и поток данных

**Статус:** Принято
**Дата:** 2026-07-11

## Контекст

Нужны одновременно: live-контур с жёсткими требованиями к свежести книг, детерминированный replay/backtest (ADR-0001) и возможность развивать детекторы независимо от коннекторов. На старте — один разработчик; микросервисная распределёнка преждевременна, но границы модулей нужны сразу.

## Решение

**Модульный монолит** в pnpm-workspaces. Общение между пакетами — только через интерфейсы `packages/core` и типизированную шину событий.

### Структура пакетов

```
packages/
  core/            # доменная модель (Instrument, OrderBook, Trade, Quote, Signal, Order),
                   # интерфейсы (VenueConnector, EventBus, Clock, Store), decimal-утилиты
  venues/
    deribit/       # коннекторы (ADR-0003)
    binance/
    bybit/
    okx/
    polymarket/
  marketdata/      # агрегация книг, нормализация к USD, контроль sequence, clock sync/латентность
  pricing/         # Black-76, IV-solver, поверхность волатильности, оценка цифровых опционов
  signals/         # детекторы арбитража (parity, cross-venue, IV/skew, calendar, digital-vs-vanilla)
  execution/       # OMS, двухногая оркестрация, контроль leg-риска, smart routing
  risk/            # pre-trade проверки, лимиты, kill switch (ADR-0006)
  persistence/     # writers в Redis/Postgres, capture JSONL, replay-reader
  backtest-engine/ # движок replay v1: та же шина событий, виртуальные часы, marketdata → signals → risk → paper execution → PnL report
apps/
  collector/       # только сбор данных + capture (prod-режим 24/7)
  trader/          # сигналы + риск + исполнение (paper/live по флагу)
  backtest/        # thin CLI over packages/backtest-engine: replay capture-файлов через pipeline
config/            # zod-схемы конфигурации, env-маппинг
```

### Поток данных

```
Venue WS/REST ──► connector ──► [raw capture JSONL]
                     │
                     ▼  (нормализация)
              EventBus (in-process) ──► marketdata (книги, USD-нормализация)
                     │
                     ▼
                 pricing (IV, поверхность, digitals)
                     │
                     ▼
                 signals ──► risk (pre-trade) ──► execution ──► venue private API
                     │
                     ▼
              persistence (Redis hot state / Postgres audit)
```

### Ключевые правила

- **EventBus v1 — in-process** типизированный (Node `EventEmitter` под интерфейсом `EventBus`). При разнесении по процессам/хостам заменяется на NATS без изменения пакетов
- **Часы через интерфейс `Clock`**: live — системное время; replay — виртуальное время из capture-файла. Код пакетов не вызывает `Date.now()` напрямую
- **Capture-first**: любое сырое сообщение биржи пишется до нормализации — replay воспроизводит байт-в-байт тот же поток
- Все пакеты pure-конфигурируемые: один и тот же код работает в `collector`, `trader`, `backtest`
- Публичный API пакета — только `index.ts`; внутренние файлы не импортируются извне (контроль eslint-boundaries)

## Последствия

- Новая биржа = новый пакет в `packages/venues/*` + регистрация в конфиге; остальная система не меняется
- Новый детектор = новый модуль в `signals`, подписанный на нормализованные события; тестируется на replay без бирж
- Один процесс v1 → проще деплой и отладка; масштабирование по процессам — осознанный следующий шаг через замену EventBus
- Дисциплина интерфейсов обязательна: без неё монолит деградирует в «big ball of mud» — проверяется линтером и ревью
