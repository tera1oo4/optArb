import { describe, expect, it, vi } from 'vitest';
import { dec, type Venue } from '@optarb/core';
import {
  DEFAULT_FEE_SCHEDULES,
  OmsEngine,
  PaperPortfolio,
  type ExecutionIntent,
} from '@optarb/execution';
import type { AuditWriter } from '@optarb/persistence';
import { LiveOrderSender } from './live-order-sender.js';
import type { GatewayOrderEvent, OrderGateway, OrderRequest } from './order-gateway.js';

function makeIntent(): ExecutionIntent {
  return {
    signalId: 's:1',
    signalKind: 'cross-venue',
    tsMs: 1000,
    legs: [
      {
        venue: 'deribit',
        instrumentId: 'deribit:BTC-OPT',
        viewKey: 'BTC:12345:50000:call',
        underlying: 'BTC',
        side: 'buy',
        priceUsd: dec('1000'),
        sizeCoin: dec('1'),
        indexPriceUsd: dec('64000'),
        quoteRecvMs: 900,
      },
      {
        venue: 'okx',
        instrumentId: 'okx:BTC-OPT',
        viewKey: 'BTC:12345:50000:call',
        underlying: 'BTC',
        side: 'sell',
        priceUsd: dec('1100'),
        sizeCoin: dec('1'),
        indexPriceUsd: dec('64000'),
        quoteRecvMs: 900,
      },
    ],
  };
}

class FakeGateway implements OrderGateway {
  readonly venue: Venue;
  private readonly events: GatewayOrderEvent[];

  constructor(venue: Venue, events: GatewayOrderEvent[]) {
    this.venue = venue;
    this.events = events;
  }

  async submit(req: OrderRequest, onEvent: (event: GatewayOrderEvent) => void): Promise<void> {
    for (const event of this.events) {
      onEvent(event);
    }
  }

  async cancel(): Promise<void> {}
}

function createEngineAndSender(opts: {
  deribitEvents?: GatewayOrderEvent[];
  okxEvents?: GatewayOrderEvent[];
  audit?: AuditWriter;
}) {
  const engine = new OmsEngine({
    timeoutMs: 5_000,
    maxAttempts: 1,
    feeSchedules: DEFAULT_FEE_SCHEDULES,
  });
  const portfolio = new PaperPortfolio();
  const gateways = new Map<Venue, OrderGateway>([
    ['deribit', new FakeGateway('deribit', opts.deribitEvents ?? [])],
    ['okx', new FakeGateway('okx', opts.okxEvents ?? [])],
  ]);
  const audit: AuditWriter =
    opts.audit ??
    ({
      writeOrder: vi.fn().mockResolvedValue('order-1'),
      writeFills: vi.fn().mockResolvedValue(undefined),
      writePosition: vi.fn().mockResolvedValue(undefined),
      writeRiskDecision: vi.fn().mockResolvedValue(undefined),
      writePortfolioSnapshot: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue(true),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditWriter);

  const sender = new LiveOrderSender({
    gateways,
    engine,
    portfolio,
    fees: DEFAULT_FEE_SCHEDULES,
    audit,
  });
  engine.setCommandSender(sender);
  return { engine, portfolio, sender, audit };
}

describe('LiveOrderSender', () => {
  it('routes a stub-like rejection to the OMS engine', async () => {
    const { engine } = createEngineAndSender({
      deribitEvents: [
        { kind: 'reject', tsMs: 1001, reason: 'live trading not configured for deribit' },
      ],
    });

    const intent = makeIntent();
    engine.submit(intent, 1000);
    await new Promise((r) => setTimeout(r, 10));

    const attempts = engine.getAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('rejected');
  });

  it('applies confirmed fills to the portfolio and audits them', async () => {
    const { engine, portfolio, audit } = createEngineAndSender({
      deribitEvents: [
        { kind: 'ack', tsMs: 1001, exchangeOrderId: 'd-1' },
        {
          kind: 'fill',
          tsMs: 1002,
          priceUsd: dec('1000'),
          sizeCoin: dec('1'),
          feeUsd: dec('0.5'),
        },
      ],
      okxEvents: [
        { kind: 'ack', tsMs: 1001, exchangeOrderId: 'o-1' },
        {
          kind: 'fill',
          tsMs: 1002,
          priceUsd: dec('1100'),
          sizeCoin: dec('1'),
          feeUsd: dec('0.5'),
        },
      ],
    });

    const intent = makeIntent();
    engine.submit(intent, 1000);
    await new Promise((r) => setTimeout(r, 10));

    const attempts = engine.getAttempts();
    expect(attempts[0]!.status).toBe('filled');

    const deribitPos = portfolio.getPosition('deribit', 'deribit:BTC-OPT');
    expect(deribitPos?.qty.toString()).toBe('1');

    const okxPos = portfolio.getPosition('okx', 'okx:BTC-OPT');
    expect(okxPos?.qty.toString()).toBe('-1');

    expect(audit.writeFills).toHaveBeenCalled();
  });
});
