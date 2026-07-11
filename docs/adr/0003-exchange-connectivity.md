# ADR-0003: Подключение к биржам — нативные коннекторы вместо CCXT

**Статус:** Принято
**Дата:** 2026-07-11

## Контекст

CCXT даёт унифицированный API для сотен бирж, но для нашей задачи у него слабые места:

- опционные WS-потоки (греки, IV, mark price) покрыты неполно или с задержкой нормализации;
- Polymarket CLOB (L1/L2-аутентификация, подпись ордеров, token IDs) в CCXT отсутствует как first-class;
- лишний слой абстракции на горячем пути → латентность и потеря venue-specific данных (sequence numbers, флаги ликвидаций и т.п.);
- каждая из 5 площадок имеет критичные особенности heartbeat/реконнекта/лимитов, которые всё равно придётся учитывать явно.

## Решение

Для каждой площадки — **собственный нативный коннектор**, реализующий единый интерфейс `VenueConnector` из `packages/core`. CCXT допустим только в утилитарных скриптах (справочники, backfill), **не** на горячем пути.

### Общие требования ко всем коннекторам

1. Метаданные инструментов (мультипликатор, тик, валюта котирования, экспирация) **загружаются из API биржи при старте** — никогда не хардкодятся
2. Reconnect с exponential backoff + повторная подписка + ресинхронизация книги по snapshot
3. Контроль целостности книги по sequence (напр. `prev_change_id` у Deribit) → при разрыве автоматический resync
4. Heartbeat строго по правилам площадки (разные у всех пяти — см. скилл `exchange-connectors`)
5. Централизованный rate limiter (token bucket) на каждую площадку, раздельно REST/WS
6. Все сырые сообщения пишутся в capture-лог (JSONL) для replay (ADR-0004)
7. Нормализация в единую модель: `Instrument`, `OrderBook`, `Trade`, `Ticker`, приведение цен к USD-эквиваленту через индексный курс

### Сводка по площадкам

| Площадка | REST | WebSocket (prod) | Тестовая среда | Особенности |
|---|---|---|---|---|
| Deribit | `https://www.deribit.com/api/v2` | `wss://www.deribit.com/ws/api/v2` (JSON-RPC 2.0) | `wss://test.deribit.com/ws/api/v2` | ≤32 соед./IP, ≤16 сессий/API-ключ; премии опционов **в BTC/ETH** |
| Binance Options | `https://eapi.binance.com/eapi/v1` | `wss://nbstream.binance.com/eoptions/ws/<stream>`; combined `.../eoptions/stream?streams=` | нет публичного options-testnet | европейские, расчёт USDT; символ `BTC-251226-100000-C` |
| Bybit | `https://api.bybit.com/v5` | `wss://stream.bybit.com/v5/public/option` | `wss://stream-testnet.bybit.com/v5/public/option` | расчёт USDC; ping `{"op":"ping"}` каждые 20с |
| OKX | `https://www.okx.com/api/v5` | `wss://ws.okx.com:8443/ws/v5/public` (+`/private`) | `wss://wspap.okx.com:8443/...` + header `x-simulated-trading: 1` | `instType=OPTION`; ping текстом `ping` |
| Polymarket | `https://clob.polymarket.com` + Gamma `https://gamma-api.polymarket.com` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` (+`/user`) | нет (только mainnet Polygon) | heartbeat клиентский `{}` каждые 10с; L1 EIP-712 + L2 HMAC; chain 137; цены 0–1 USDC |

Детальные каналы, поля и типичные ошибки — в проектном скилле `.kimi-code/skills/exchange-connectors/SKILL.md` (вызывается `/skill:exchange-connectors`).

## Последствия

- Больше кода на старте (5 коннекторов), но полный контроль над sequence/heartbeat/лимитами — ключ к достоверным книгам, без которых арбитражные сигналы ложны
- Polymarket интегрируется тем же интерфейсом `VenueConnector`: бинарный контракт = инструмент с payoff 0/1, цена = implied probability
- Появление/изменение каналов бирж (напр. переименование поля `changes`→`price_changes` у Polymarket в 2025) локализовано в одном пакете коннектора и покрыто replay-тестами
- Testnet-покрытие неполное (Binance Options, Polymarket) → paper-режим обязателен как первый этап (ADR-0006)
