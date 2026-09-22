# ADR-0007: Авто-килл-свитч и недостающие лимиты ADR-0006

**Статус:** Принято
**Дата:** 2026-09-22

## Контекст

ADR-0006 требует автосрабатывания kill switch (разрыв sequence, потеря heartbeat, всплеск reject-ов), лимитов греков, проверки маржи и лимита settlement-риска Polymarket. Ревизия 2026-09 показала, что ни один из этих пунктов не реализован в коде, а `packages/live` уже умеет отправлять реальные ордера. Дополнительно ревизия выявила: отсутствие pino-redaction, прямые вызовы `Date.now()` в `packages/live`, сравнение JS-float с Decimal в risk-конфиге, аудит только deny-решений и дублирование risk-check → audit → execute в `apps/trader`.

## Решение

1. **AutoKillSwitch** (`packages/risk`): триггеры heartbeat loss (`RISK_AUTO_KILL_HEARTBEAT_IDLE_MS`, default 60s), серия sequence-gap (`RISK_AUTO_KILL_SEQUENCE_GAPS`/`_WINDOW_MS`, default 3/60s), всплеск reject-ов (`RISK_AUTO_KILL_REJECT_COUNT`/`_WINDOW_MS`, default 5/60s). Свитч **latch-ится**: снятие только операторским `reset()`. Срабатывание пишется в Redis (`setKillSwitch(true)`), рестарт остаётся остановленным. Все метки времени — через `Clock` (детерминированный replay).
2. **Событие `venue.sequence-gap`** на шине: коннекторы deribit/bybit/binance публикуют его при ресинке книги; trader кормит им AutoKillSwitch. Heartbeat — из существующих `market.*` хендлеров, reject-спайки — через `onReject`-хук `LiveOrderSender`.
3. **Лимиты греков/маржи/settlement** (`RiskEngine.check`): `RISK_MAX_{DELTA,VEGA,GAMMA}_PER_UNDERLYING`, `RISK_MIN_MARGIN_HEADROOM_USD`, `RISK_MAX_POLYMARKET_SETTLEMENT_USD`. Все опциональны: unset = проверка пропущена (paper-портфель греки и маржу пока не отдаёт — см. Последствия).
4. **Закрытие гэпов ревизии**: pino-redaction по ключам секретов (`LOG_REDACT_PATHS` в `core`, подключён во всех apps); `Clock` инжектирован в `LiveOrderSender` и все gateway-адаптеры; money/bps-лимиты risk-конфига — `Decimal` через zod-preprocess; аудит **всех** решений risk (allow + deny) в едином `signal-pipeline.ts`, убравшем дублирование двух веток детекторов.
5. **Тесты**: `auto-kill-switch` (heartbeat loss, burst/window, spike, latch, reset, per-venue), greeks/margin/settlement в `engine.test.ts`, `config.test.ts` (парсинг Decimal из env), `ws-connector.test.ts` (handshake, heartbeat, reconnect, no-reconnect-after-disconnect). Coverage-секция в `vitest.config.ts`.

## Последствия

- `RiskState` расширен опциональными `greeksPerUnderlying`, `marginHeadroomUsd`, `polymarketSettlementExposureUsd`; маппинг из портфеля/веню — следующая работа (пока проверки пропускаются при отсутствии данных, что покрыто тестами).
- `RiskConfigSchema` обратно совместим на уровне env (строки/числа принимаются), но программные литералы `RiskConfig` теперь требуют `Decimal` для money/bps-полей и новых обязательные tripwire-поля.
- `DERIBIT_TESTNET` вынесен в env (default `true` — безопасное направление).
- ADR-0006 остаётся действующим; настоящий ADR фиксирует догоняющую реализацию его пунктов, а не новое направление.
