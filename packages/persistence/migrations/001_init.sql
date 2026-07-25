-- ## up

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signal_id TEXT NOT NULL,
  signal_kind TEXT NOT NULL,
  venue_buy TEXT NOT NULL,
  venue_sell TEXT NOT NULL,
  requested_notional_usd DECIMAL(36, 18) NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_signal_id ON orders(signal_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

CREATE TABLE IF NOT EXISTS fills (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  venue TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  price_usd DECIMAL(36, 18) NOT NULL,
  size_coin DECIMAL(36, 18) NOT NULL,
  fee_usd DECIMAL(36, 18) NOT NULL,
  notional_usd DECIMAL(36, 18) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fills_order_id ON fills(order_id);
CREATE INDEX IF NOT EXISTS idx_fills_created_at ON fills(created_at);

CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  venue TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('long', 'short')),
  size_coin DECIMAL(36, 18) NOT NULL,
  avg_entry_usd DECIMAL(36, 18) NOT NULL,
  realized_pnl_usd DECIMAL(36, 18) NOT NULL,
  unrealized_pnl_usd DECIMAL(36, 18) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (venue, instrument_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_venue_instrument ON positions(venue, instrument_id);

CREATE TABLE IF NOT EXISTS risk_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  signal_id TEXT NOT NULL,
  allowed BOOLEAN NOT NULL,
  reasons JSONB NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_decisions_signal_id ON risk_decisions(signal_id);
CREATE INDEX IF NOT EXISTS idx_risk_decisions_checked_at ON risk_decisions(checked_at);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  total_notional_usd DECIMAL(36, 18) NOT NULL,
  realized_pnl_usd DECIMAL(36, 18) NOT NULL,
  unrealized_pnl_usd DECIMAL(36, 18) NOT NULL,
  fees_usd DECIMAL(36, 18) NOT NULL,
  net_pnl_usd DECIMAL(36, 18) NOT NULL,
  positions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_created_at ON portfolio_snapshots(created_at);

-- ## down

DROP TABLE IF EXISTS portfolio_snapshots;
DROP TABLE IF EXISTS risk_decisions;
DROP TABLE IF EXISTS fills;
DROP TABLE IF EXISTS positions;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS migrations;
