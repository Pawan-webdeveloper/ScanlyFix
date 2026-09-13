import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const findCanaryByHoneytokenMock = vi.fn();
const insertCanaryEventsMock = vi.fn();
const countRecentHoneytokenHitsMock = vi.fn();
const getProjectOwnerEmailMock = vi.fn();
const getRuntimeProjectContextMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  findCanaryByHoneytoken: (...args: unknown[]) => findCanaryByHoneytokenMock(...args),
  insertCanaryEvents: (...args: unknown[]) => insertCanaryEventsMock(...args),
  countRecentHoneytokenHits: (...args: unknown[]) => countRecentHoneytokenHitsMock(...args),
  getProjectOwnerEmail: (...args: unknown[]) => getProjectOwnerEmailMock(...args),
  getRuntimeProjectContext: (...args: unknown[]) => getRuntimeProjectContextMock(...args),
}));

const sendEmailMock = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

type InngestHandler = (ctx: {
  event: { data: Record<string, unknown> };
  step: {
    run: <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;
  };
  logger: { info: Mock; warn: Mock; error: Mock };
}) => Promise<unknown>;

const { inngestSendMock, setHandler, getHandler } = vi.hoisted(() => {
  let storedHandler: ((...args: unknown[]) => unknown) | undefined;
  return {
    inngestSendMock: vi.fn(),
    setHandler: (h: unknown) => {
      storedHandler = h as (...args: unknown[]) => unknown;
    },
    getHandler: () => storedHandler as unknown as InngestHandler,
  };
});

vi.mock('@/lib/inngest', () => ({
  EVENTS: {
    canaryHoneytokenHit: 'runtime/canary.honeytoken-hit',
  },
  inngest: {
    send: (...args: unknown[]) => inngestSendMock(...args),
    createFunction: (_config: { id: string }, handler: InngestHandler) => {
      setHandler(handler);
      return { handler };
    },
  },
}));

import { GET, POST, DELETE } from '../app/api/runtime/honeytoken/[token]/route';
import { runtimeCanaryHoneytokenAlert } from '../inngest/functions/runtime-canary-honeytoken';

function makeInngestContext(eventData: Record<string, unknown>) {
  return {
    event: { data: eventData },
    step: {
      run: async <T>(_name: string, fn: () => Promise<T> | T) => fn(),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe('Honeytoken route and instant alert worker (TASK 4)', () => {
  const canaryRow = {
    id: 'canary-uuid-1',
    projectId: 'proj-123',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectOwnerEmailMock.mockResolvedValue('owner@example.com');
    getRuntimeProjectContextMock.mockResolvedValue({ hostname: 'app.example.com' });
  });

  it('unknown token → returns generic 200 with no-store and records no events', async () => {
    findCanaryByHoneytokenMock.mockResolvedValueOnce(null);

    const req = new Request('https://scanlyfix.dev/api/runtime/honeytoken/unknown-token', {
      method: 'GET',
    });
    const res = await GET(req, { params: Promise.resolve({ token: 'unknown-token' }) });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0');
    const json = await res.json();
    expect(json).toEqual({ status: 'received' });

    // No event inserted and no Inngest event fired
    expect(insertCanaryEventsMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('works with any HTTP method (POST, DELETE) and preserves generic 200 response', async () => {
    findCanaryByHoneytokenMock.mockResolvedValue(canaryRow);

    const postReq = new Request('https://scanlyfix.dev/api/runtime/honeytoken/valid-token', {
      method: 'POST',
    });
    const postRes = await POST(postReq, { params: Promise.resolve({ token: 'valid-token' }) });
    expect(postRes.status).toBe(200);
    expect(postRes.headers.get('cache-control')).toBe('no-store, max-age=0');

    const delReq = new Request('https://scanlyfix.dev/api/runtime/honeytoken/valid-token', {
      method: 'DELETE',
    });
    const delRes = await DELETE(delReq, { params: Promise.resolve({ token: 'valid-token' }) });
    expect(delRes.status).toBe(200);

    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(2);
  });

  it('two hits 1 minute apart → 2 events recorded, exactly 1 email sent (rate-limited)', async () => {
    findCanaryByHoneytokenMock.mockResolvedValue(canaryRow);

    // Track events recorded in the database
    const recordedEvents: unknown[] = [];
    insertCanaryEventsMock.mockImplementation((events: unknown[]) => {
      recordedEvents.push(...events);
      return Promise.resolve(events.length);
    });

    // ─── HIT 1 (T = 0) ──────────────────────────────────────────
    const req1 = new Request('https://scanlyfix.dev/api/runtime/honeytoken/secret-token-xyz', {
      method: 'GET',
    });
    const res1 = await GET(req1, { params: Promise.resolve({ token: 'secret-token-xyz' }) });

    expect(res1.status).toBe(200);
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
    expect(inngestSendMock).toHaveBeenCalledTimes(1);

    // Inngest worker runs for Hit 1: count of recent hits in last 60m is 1 (first hit)
    countRecentHoneytokenHitsMock.mockResolvedValueOnce(1);
    const hit1EventData = inngestSendMock.mock.calls[0]?.[0]?.data;
    const workerRes1 = await getHandler()!(makeInngestContext(hit1EventData));

    expect(workerRes1).toMatchObject({ alerted: true, to: 'owner@example.com' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // ─── HIT 2 (T = 1 minute later) ─────────────────────────────
    const req2 = new Request('https://scanlyfix.dev/api/runtime/honeytoken/secret-token-xyz', {
      method: 'POST',
    });
    const res2 = await POST(req2, { params: Promise.resolve({ token: 'secret-token-xyz' }) });

    expect(res2.status).toBe(200);
    // Total events recorded is now 2 (every hit is evidence!)
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(2);
    expect(recordedEvents).toHaveLength(2);
    expect(inngestSendMock).toHaveBeenCalledTimes(2);

    // Inngest worker runs for Hit 2: count of recent hits in last 60m is now 2
    countRecentHoneytokenHitsMock.mockResolvedValueOnce(2);
    const hit2EventData = inngestSendMock.mock.calls[1]?.[0]?.data;
    const workerRes2 = await getHandler()!(makeInngestContext(hit2EventData));

    expect(workerRes2).toMatchObject({ alerted: false, reason: 'rate_limited' });
    // Email count must REMAIN 1!
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
