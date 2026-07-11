---
name: exchange-connectors
description: Справочник по API площадок проекта optArb (Deribit, Binance Options, Bybit, OKX, Polymarket) — эндпоинты REST/WS, каналы подписок, аутентификация, heartbeat, лимиты и типичные ошибки
type: prompt
whenToUse: Когда пишется или отлаживается код коннекторов к биржам, WebSocket-подписки, реконнекты, аутентификация, нормализация инструментов, или нужны точные URL/каналы/лимиты площадки
---

# Коннекторы бирж — справочник optArb

Детали протоколов меняются — при расхождении с кодом/доками сверяться с официальной документацией (ссылки внизу каждого раздела) и обновлять этот скилл.

## Общие правила (ADR-0003)

1. Метаданные инструментов (multiplier, tick size, валюта котирования, экспирация) загружаются из API при старте — **не хардкодить**
2. Reconnect с exponential backoff → повторная auth → повторная подписка → resync книги по snapshot
3. Контроль sequence книги; при разрыве — resync, книга помечается stale до синхронизации
4. Heartbeat строго по правилам площадки (у всех разный!)
5. Token-bucket rate limiter на площадку, раздельно REST и WS
6. Сырые сообщения — в JSONL capture до нормализации

---

## Deribit

| | prod | testnet |
|---|---|---|
| WS | `wss://www.deribit.com/ws/api/v2` | `wss://test.deribit.com/ws/api/v2` |
| REST | `https://www.deribit.com/api/v2` | `https://test.deribit.com/api/v2` |

- Протокол: **JSON-RPC 2.0**; только named params; нет batch; ответы могут приходить не по порядку — корреляция по `id`
- Лимиты: **≤32 WS-соединений/IP**, **≤16 сессий/API-ключ**; backpressure → сервер рвёт соединение (`connection_too_slow`)
- Auth: `public/auth` (client_credentials); heartbeat: `public/set_heartbeat` + `public/test`
- Каналы: `ticker.{instrument}.{100ms|raw}` (включает **греки и IV** для опционов), `book.{instrument}.{group}.{depth}.{interval}`, `trades.{instrument}.{interval}`, `markprice.options`, `deribit_price_index.{index}`, user: `user.orders.{instrument}.{interval}`, `user.changes.{instrument}.{interval}`
- Книга: **interval-каналы (`.100ms`) шлют полный снапшот** `{timestamp, instrument_name, change_id, bids/asks: [[price, amount]]}` — без `type` и `prev_change_id`; **`.raw`-канал** — инкрементальный (`type: snapshot|change`, `prev_change_id`) с контролем по `change_id` — разрыв → resync
- **КВАРК:** премии BTC-опционов котируются **в BTC** (ETH — в ETH), 1 контракт = 1 BTC; страйк в USD. Нормализация в USD обязательна через индекс
- Инструменты: `public/get_instruments?currency=BTC&kind=option` — source of truth для спецификаций
- Доки: https://docs.deribit.com/

## Binance Options (eapi)

| | prod |
|---|---|
| WS market | `wss://nbstream.binance.com/eoptions/ws/<streamName>` |
| WS combined | `wss://nbstream.binance.com/eoptions/stream?streams=<s1>/<s2>/...` |
| REST | `https://eapi.binance.com/eapi/v1` |

- Публичного options-testnet нет → paper-режим или минимальные размеры
- Европейские опционы, расчёт **USDT**, авто-экспирация; символ: `BTC-251226-100000-C` (`{UNDERLYING}-{YYMMDD}-{STRIKE}-{C|P}`)
- Стримы: `<symbol>@trade`, `<symbol>@depth<levels>@<100ms|1000ms>`, `<symbol>@ticker`, `<symbol>@markPrice`, `<underlying>@index` (напр. `BTCUSDT@index`), `<underlying>@openInterest`
- User data: listenKey через `POST /eapi/v1/userDataStream`, keepalive каждые 30 мин, user-стрим на том же хосте `nbstream`
- Метаданные: `GET /eapi/v1/exchangeInfo` (мультипликаторы, тики, лоты)
- Доки: https://developers.binance.com/docs/derivatives/option

## Bybit (Unified V5)

| | prod | testnet |
|---|---|---|
| WS public option | `wss://stream.bybit.com/v5/public/option` | `wss://stream-testnet.bybit.com/v5/public/option` |
| WS private | `wss://stream.bybit.com/v5/private` | `wss://stream-testnet.bybit.com/v5/private` |
| REST | `https://api.bybit.com/v5` | `https://api-testnet.bybit.com/v5` |

- Расчёт **USDC**, европейские, авто-экспирация; символ: `BTC-26DEC25-100000-C`
- Топики: `tickers.{symbol}`, `orderbook.{1|25|50|100|200}.{symbol}`, `publicTrade.{baseCoin}` (**для опционов — baseCoin**, напр. `publicTrade.BTC`)
- **Heartbeat: клиентский ping `{"op":"ping"}` каждые 20с** (иначе разрыв; типичная ошибка новичков — потеря соединения через ~30с)
- Книга: сначала `snapshot`, затем `delta` с контролем `u`/`seq`; при несостыковке — переподписка
- Private WS: auth сообщением (`op: auth`, api_key + expires + sign HMAC-SHA256)
- Метаданные: `GET /v5/market/instruments-info?category=option`
- Доки: https://bybit-exchange.github.io/docs/v5/

## OKX (V5)

| | prod | demo |
|---|---|---|
| WS public | `wss://ws.okx.com:8443/ws/v5/public` | `wss://wspap.okx.com:8443/ws/v5/public` |
| WS private | `wss://ws.okx.com:8443/ws/v5/private` | `wss://wspap.okx.com:8443/ws/v5/private` |
| REST | `https://www.okx.com/api/v5` | + header `x-simulated-trading: 1` |

- `instType=OPTION`, instId: `BTC-USD-251226-100000-C`; европейские, cash-settled
- Каналы: `tickers`, `books` / `books5` / `bbo-tbt` (tick-by-tick BBO), `trades`, `opt-summary` (IV, греки, mark), `mark-price`, `index-tickers`
- Подписка: `{"op":"subscribe","args":[{"channel":"books5","instId":"..."}]}`; private — сначала `op: login` (apiKey/passphrase/timestamp/sign)
- **Heartbeat: текстовый `ping` каждые ~25с → ответ `pong`**
- Метаданные: `GET /api/v5/public/instruments?instType=OPTION&uly=BTC-USD`
- Доки: https://www.okx.com/docs-v5/

## Polymarket (CLOB)

| сервис | URL |
|---|---|
| CLOB REST | `https://clob.polymarket.com` |
| Gamma API (рынки, события, метаданные) | `https://gamma-api.polymarket.com` |
| Data API (позиции, трейды, лидерборды) | `https://data-api.polymarket.com` |
| CLOB WS market | `wss://ws-subscriptions-clob.polymarket.com/ws/market` |
| CLOB WS user | `wss://ws-subscriptions-clob.polymarket.com/ws/user` |
| RTDS (цены крипты Chainlink/CEX — полезно как feed базового актива) | `wss://ws-live-data.polymarket.com` |

- Сеть: **Polygon (chainId 137)**, коллатераль USDC.e; тестнета нет — реальные деньги сразу
- SDK: `@polymarket/clob-client` (TypeScript) + `ethers` **v5**; python: `py-clob-client`
- Auth двухуровневая: **L1** — подпись EIP-712 приватным ключом (derive API key) → **L2** — HMAC по apiKey/secret/passphrase; `signatureType`: 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE (proxy wallet из polymarket.com/settings)
- WS market: подписка `{"assets_ids":[tokenId...],"type":"market","custom_feature_enabled":true}`; динамическая — `{"operation":"subscribe","assets_ids":[...]}`; события `book` (snapshot при подписке), `price_change` (delta; поле **`price_changes`** с 2025-09-15, раньше `changes`), `last_trade_price`, `tick_size_change`, `best_bid_ask`*, `new_market`*, `market_resolved`* (* — с `custom_feature_enabled`)
- **Heartbeat клиентский: `{}` каждые 10с** → ответ `{}`; пропуск ~30с → разрыв (наоборот, чем у Kalshi)
- WS user: auth **в subscribe-сообщении** `{"type":"user","auth":{"apiKey","secret","passphrase"}}`, события `order`, `trade`
- Ордера: limit/market, TIF `GTC`/`GTD`/`FOK`/`FAK`, post-only только GTC/GTD; FOK/FAK BUY — amount в **долларах**, SELL — в **shares**
- Цена контракта 0–1 USDC = implied probability; YES+NO ≈ 1 (расхождение → mint/merge через CTF `split`/`merge` — в v1 полуручной режим, ADR-0001)
- Token ID ≠ market ID: маппинг через `clobTokenIds` в метаданных Gamma; подписка идёт по **token IDs**
- Резолюция — UMA optimistic oracle: проверять resolution source/время фиксации каждого рынка (settlement-риск, ADR-0006)
- Гео-ограничения Polymarket соблюдаются на стороне инфраструктуры
- Доки: https://docs.polymarket.com/; готовый внешний скилл: LobeHub `web3-polymarket` (polyblocks) — auth, ордера, CTF, bridge; ставится в `~/.kimi-code/skills/` по решению пользователя

---

## Типичные ошибки (по опыту issues)

- **Bybit/OKX/Polymarket**: разрыв через ~30с — почти всегда забытый клиентский heartbeat (у каждой площадки свой формат!)
- **Deribit**: ответы WS неупорядочены — матчить по `id`; книга без контроля `prev_change_id` тихо расходится
- **Polymarket**: подписка по market ID вместо token ID; старые парсеры читают `data.changes` и молча теряют обновления (поле переименовано в `price_changes`); heartbeat `{}`, а не WS PING-фрейм
- **Binance**: options-символ без правильного формата даты; user stream без keepalive listenKey (30 мин)
- **Все**: хардкод multiplier/tick → расхождения при смене спецификаций; грузить из instruments-эндпоинта при старте
