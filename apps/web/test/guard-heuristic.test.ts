import { describe, expect, it } from 'vitest';

import { computeNeedsSession } from '../lib/runtime/guard/heuristic.ts';

describe('computeNeedsSession', () => {
  it('sab requests session ke saath → needs session', () => {
    expect(computeNeedsSession(50, 0)).toBe(true);
  });

  it('5% tolerance ke andar → still needs session', () => {
    // 100 me se 4 bina session = 4% ≤ 5%
    expect(computeNeedsSession(96, 4)).toBe(true);
  });

  it('5% se zyada bina-session → public route', () => {
    expect(computeNeedsSession(90, 10)).toBe(false);
    expect(computeNeedsSession(0, 20)).toBe(false);
  });

  it('min samples se kam data → kabhi guess nahi', () => {
    expect(computeNeedsSession(2, 0)).toBe(false); // 2/2 = 100% with, par data kam
    expect(computeNeedsSession(0, 0)).toBe(false);
  });

  it('min samples ke exactly boundary par kaam karta hai', () => {
    expect(computeNeedsSession(3, 0)).toBe(true);
  });
});