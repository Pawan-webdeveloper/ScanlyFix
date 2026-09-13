import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Runtime subnav links', () => {
  const proberPage = readFileSync(
    resolve(__dirname, '../app/(app)/runtime/page.tsx'),
    'utf-8',
  );
  const guardPage = readFileSync(
    resolve(__dirname, '../app/(app)/runtime/guard/page.tsx'),
    'utf-8',
  );
  const aiPage = readFileSync(
    resolve(__dirname, '../app/(app)/runtime/ai/page.tsx'),
    'utf-8',
  );
  const canariesPage = readFileSync(
    resolve(__dirname, '../app/(app)/runtime/canaries/page.tsx'),
    'utf-8',
  );

  it('includes links to all other 3 features from Auth Prober page', () => {
    expect(proberPage).toContain('/runtime/guard?projectId=');
    expect(proberPage).toContain('/runtime/ai?projectId=');
    expect(proberPage).toContain('/runtime/canaries?projectId=');
  });

  it('includes links to all other 3 features from Guard page', () => {
    expect(guardPage).toContain('/runtime?projectId=');
    expect(guardPage).toContain('/runtime/ai?projectId=');
    expect(guardPage).toContain('/runtime/canaries?projectId=');
  });

  it('includes links to all other 3 features from AI Spend page', () => {
    expect(aiPage).toContain('/runtime?projectId=');
    expect(aiPage).toContain('/runtime/guard?projectId=');
    expect(aiPage).toContain('/runtime/canaries?projectId=');
  });

  it('includes links to all other 3 features from Canaries page', () => {
    expect(canariesPage).toContain('/runtime?projectId=');
    expect(canariesPage).toContain('/runtime/guard?projectId=');
    expect(canariesPage).toContain('/runtime/ai?projectId=');
    expect(canariesPage).toContain('Canaries');
  });

  it('canaries page parses searchParams instead of non-existent params', () => {
    expect(canariesPage).toContain('searchParams');
    expect(canariesPage).not.toContain('params: Promise<{ projectId: string }>');
  });
});
