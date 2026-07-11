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

## Структура (целевая, ADR-0004)

```
packages/core | venues/{deribit,binance,bybit,okx,polymarket} | marketdata |
pricing | signals | execution | risk | persistence | backtest
apps/collector | apps/trader | apps/backtest
```

## Команды

> Проект на стадии дизайна; `package.json` ещё не создан. После scaffolding ожидаются:

```bash
pnpm install            # установка зависимостей
pnpm build              # сборка всех пакетов
pnpm test               # vitest (unit + replay)
pnpm lint               # eslint + prettier --check
pnpm dev:collector      # сбор рыночных данных + capture
pnpm dev:trader         # paper-режим по умолчанию
pnpm backtest -- <file> # replay capture-файла
```

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
