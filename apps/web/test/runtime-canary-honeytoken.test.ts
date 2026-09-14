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

/**
 * The honeytoken endpoint: unauthenticated by design, and therefore the one
 * surface an attacker can aim at us rather than at the customer.
 */
describe('honeytoken endpoint', () => {
  const canaryRow = {
    id: 'canary-1',
    projectId: 'proj-1',
    markerToken: 'CANARY::proj1234::ab12::A',
    status: 'planted',
  };

  function hit(token: string, method: 'GET' | 'POST' | 'DELETE' = 'GET') {
    const req = new Request(`https://scanlyfix.dev/api/runtime/honeytoken/${token}`, { method });
    const handler = method === 'POST' ? POST : method === 'DELETE' ? DELETE : GET;
    return handler(req, { params: Promise.resolve({ token }) });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    findCanaryByHoneytokenMock.mockResolvedValue(canaryRow);
    countRecentHoneytokenHitsMock.mockResolvedValue(0);
    insertCanaryEventsMock.mockResolvedValue(1);
    getProjectOwnerEmailMock.mockResolvedValue('owner@example.com');
    getRuntimeProjectContextMock.mockResolvedValue({ hostname: 'my-saas.com' });
  });

  it('answers identically for a real and an unknown token, so probing reveals nothing', async () => {
    const real = await hit('aaaaaaaaaaaaaaaa');
    findCanaryByHoneytokenMock.mockResolvedValue(null);
    const fake = await hit('bbbbbbbbbbbbbbbb');

    expect(real.status).toBe(fake.status);
    expect(await real.json()).toEqual(await fake.json());
    expect(real.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(fake.headers.get('cache-control')).toBe('no-store, max-age=0');
  });

  it('records nothing for an unknown token', async () => {
    findCanaryByHoneytokenMock.mockResolvedValue(null);
    await hit('cccccccccccccccc');
    expect(insertCanaryEventsMock).not.toHaveBeenCalled();
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it('never queries the database for a token that cannot be one', async () => {
    // The path is 12 random bytes in base64url; anything else is noise aimed at us.
    await hit('../../etc/passwd' as string);
    await hit('short');
    expect(findCanaryByHoneytokenMock).not.toHaveBeenCalled();
  });

  it('records a hit on any HTTP method', async () => {
    const res = await hit('dddddddddddddddd', 'DELETE');
    expect(res.status).toBe(200);
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
    expect(insertCanaryEventsMock.mock.calls[0]![0][0]).toMatchObject({
      projectId: 'proj-1',
      canaryId: 'canary-1',
      kind: 'honeytoken_hit',
      source: 'honeytoken',
    });
  });

  it('collapses a flood into one recorded event, so an anonymous caller cannot choose our storage', async () => {
    // First hit records; the rest land inside the window and are dropped.
    await hit('eeeeeeeeeeeeeeee');
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);

    countRecentHoneytokenHitsMock.mockResolvedValue(1);
    for (let i = 0; i < 20; i++) await hit('eeeeeeeeeeeeeeee');

    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
  });

  it('enqueues an alert for the first hit of the hour and not for later ones', async () => {
    await hit('ffffffffffffffff');
    expect(inngestSendMock).toHaveBeenCalledTimes(1);

    // A later, separate burst: outside the record window but inside the hour.
    countRecentHoneytokenHitsMock.mockImplementation(async (_id: string, minutes: number) => (minutes <= 5 ? 0 : 1));
    await hit('gggggggggggggggg');

    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(2); // still evidence
    expect(inngestSendMock).toHaveBeenCalledTimes(1); // but not a second email
  });

  it('still records a hit on a RETIRED canary, which is the hit that matters most', async () => {
    // After recovery the old decoys are retired, and the payload carrying that
    // URL is exactly the one already out in the world.
    findCanaryByHoneytokenMock.mockResolvedValue({ ...canaryRow, status: 'retired' });
    await hit('hhhhhhhhhhhhhhhh');

    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
    const detail = insertCanaryEventsMock.mock.calls[0]![0][0].detail as string;
    expect(detail).toMatch(/retired during recovery/i);
  });

  it('records a hit on a COMPROMISED canary too', async () => {
    findCanaryByHoneytokenMock.mockResolvedValue({ ...canaryRow, status: 'compromised' });
    await hit('iiiiiiiiiiiiiiii');
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
  });

  it('answers normally when the database write fails', async () => {
    insertCanaryEventsMock.mockRejectedValue(new Error('db down'));
    const res = await hit('jjjjjjjjjjjjjjjj');
    expect(res.status).toBe(200);
  });

  it('answers normally when the queue is unavailable', async () => {
    inngestSendMock.mockRejectedValue(new Error('inngest down'));
    const res = await hit('kkkkkkkkkkkkkkkk');
    expect(res.status).toBe(200);
    expect(insertCanaryEventsMock).toHaveBeenCalledTimes(1);
  });
});

describe('honeytoken alert worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectOwnerEmailMock.mockResolvedValue('owner@example.com');
    getRuntimeProjectContextMock.mockResolvedValue({ hostname: 'my-saas.com' });
  });

  it('sends the email the route asked for, without second-guessing the rate limit', async () => {
    // The route decides; the worker sends. It used to re-count hits afterwards,
    // which included its own and suppressed the alert when two landed together.
    void runtimeCanaryHoneytokenAlert;
    const res = await getHandler()!(
      makeInngestContext({ projectId: 'proj-1', canaryId: 'canary-1', detail: 'Honeytoken for decoy X was requested (GET).' }),
    );

    expect(res).toMatchObject({ alerted: true, to: 'owner@example.com' });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const email = sendEmailMock.mock.calls[0]![0] as { subject: string; text: string };
    expect(email.subject).toContain('my-saas.com');
    expect(email.text).toMatch(/honeytoken/i);
    expect(email.text).toMatch(/rotate/i);
  });

  it('does nothing when the project has no owner email', async () => {
    getProjectOwnerEmailMock.mockResolvedValue(null);
    const res = await getHandler()!(makeInngestContext({ projectId: 'proj-1', canaryId: 'c', detail: 'x' }));
    expect(res).toMatchObject({ alerted: false, reason: 'no_owner_email' });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
