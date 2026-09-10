import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const listProberEligibleProjectIdsMock = vi.fn();
const getProjectOwnerEmailMock = vi.fn();
const getRuntimeProjectContextMock = vi.fn();

vi.mock('@scanlyfix/db', () => ({
  listProberEligibleProjectIds: (...args: unknown[]) => listProberEligibleProjectIdsMock(...args),
  getProjectOwnerEmail: (...args: unknown[]) => getProjectOwnerEmailMock(...args),
  getRuntimeProjectContext: (...args: unknown[]) => getRuntimeProjectContextMock(...args),
}));

const runAuthProberMock = vi.fn();
vi.mock('../lib/runtime/auth-prober/index.ts', () => ({
  runAuthProber: (...args: unknown[]) => runAuthProberMock(...args),
}));

const sendEmailMock = vi.fn();
vi.mock('../lib/email.ts', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

type InngestHandler = (ctx: {
  step: { run: (name: string, fn: () => unknown) => Promise<unknown> };
  logger: { info: Mock; warn: Mock; error: Mock };
}) => Promise<unknown>;

let registeredHandler: InngestHandler | null = null;
vi.mock('../lib/inngest.ts', () => ({
  inngest: {
    createFunction: (_config: unknown, handler: InngestHandler) => {
      registeredHandler = handler;
      return { __handler: handler };
    },
  },
}));

await import('../inngest/functions/runtime-auth-prober.ts');

function makeContext() {
  return {
    step: {
      run: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe('runtime auth prober Inngest nightly cron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs cleanly when no projects are eligible', async () => {
    listProberEligibleProjectIdsMock.mockResolvedValueOnce([]);

    const ctx = makeContext();
    const result = await registeredHandler!(ctx as never);

    expect(result).toEqual({ runs: [] });
    expect(runAuthProberMock).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith('auth-prober: eligible projects', { count: 0 });
  });

  it('probes eligible projects and records summary', async () => {
    listProberEligibleProjectIdsMock.mockResolvedValueOnce(['proj_1', 'proj_2']);
    runAuthProberMock.mockResolvedValue({
      projectId: 'proj_1',
      ranAt: new Date().toISOString(),
      baselinesRecorded: 0,
      checked: 10,
      newFindings: 0,
      autoResolved: 0,
      stillOpen: 0,
      errors: 0,
    });

    const ctx = makeContext();
    const result = (await registeredHandler!(ctx as never)) as { runs: string[] };

    expect(runAuthProberMock).toHaveBeenCalledTimes(2);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toContain('proj_1 → baseline:0 checked:10 new:0 resolved:0 open:0 err:0');
  });

  it('triggers email alert on new findings via onNewFindings hook', async () => {
    listProberEligibleProjectIdsMock.mockResolvedValueOnce(['proj_1']);
    getProjectOwnerEmailMock.mockResolvedValueOnce('founder@example.com');
    getRuntimeProjectContextMock.mockResolvedValueOnce({
      id: 'proj_1',
      hostname: 'app.example.com',
      isVerified: true,
    });

    runAuthProberMock.mockImplementationOnce(async (projectId, hooks) => {
      await hooks.onNewFindings?.([
        {
          path: '/admin',
          severity: 'critical',
          baselineStatus: 403,
          actualStatus: 200,
        },
      ]);
      return {
        projectId,
        ranAt: new Date().toISOString(),
        baselinesRecorded: 0,
        checked: 5,
        newFindings: 1,
        autoResolved: 0,
        stillOpen: 0,
        errors: 0,
      };
    });

    const ctx = makeContext();
    await registeredHandler!(ctx as never);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'founder@example.com',
        subject: expect.stringContaining('app.example.com'),
      }),
    );
  });
});
