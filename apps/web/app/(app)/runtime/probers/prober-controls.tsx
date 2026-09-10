'use client';

import { useTransition } from 'react';
import { runProberAction } from './action';
import { recordBaselineButtonLabel } from './prober-view';

export function ProberControls({ projectId, hasBaseline, targetCount }: {
  projectId: string;
  hasBaseline: boolean;
  targetCount: number;
}) {
  const [pending, startTransition] = useTransition();
  const label = recordBaselineButtonLabel(hasBaseline, targetCount);

  return (
    <div className="flex items-center gap-4">
      <button
        disabled={pending || targetCount === 0}
        onClick={() => {
          startTransition(() => {
            runProberAction(projectId);
          });
        }}
        className="inline-flex h-9 items-center justify-center rounded-lg bg-c-accent px-4 text-sm font-medium text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'Running...' : label}
      </button>
      <p className="text-xs text-c-muted">
        {targetCount} target{targetCount !== 1 ? 's' : ''} configured
      </p>
    </div>
  );
}
