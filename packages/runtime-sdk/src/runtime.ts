import type { RouteEvent } from './guard/observe.ts';

export interface RuntimeConfig {
  projectId: string;
  signingSecret: string;
  ingestUrl: string;
  maxBatchSize?: number;
  flushIntervalMs?: number;
  onError?: (err: unknown) => void;
}

export interface RuntimeClient {
  config: RuntimeConfig;
  report: (event: RouteEvent) => void;
  flush: () => Promise<void>;
}

export function createRuntime(config: RuntimeConfig): RuntimeClient {
  const queue: RouteEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(): Promise<void> {
    if (queue.length === 0) return;
    const batch = queue.splice(0, config.maxBatchSize ?? 10);
    if (!config.ingestUrl) return;

    try {
      await fetch(config.ingestUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-runtime-project-id': config.projectId,
          'x-runtime-signature': config.signingSecret,
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch (err) {
      config.onError?.(err);
    }
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, config.flushIntervalMs ?? 5_000);
  }

  return {
    config,
    report(event: RouteEvent) {
      queue.push(event);
      if (queue.length >= (config.maxBatchSize ?? 10)) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void flush();
      } else {
        scheduleFlush();
      }
    },
    flush,
  };
}
