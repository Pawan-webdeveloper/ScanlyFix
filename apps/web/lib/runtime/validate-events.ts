export function isValidStatus(status: unknown): boolean {
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599;
}

export function isValidDuration(durationMs: unknown): boolean {
  return typeof durationMs === 'number' && Number.isInteger(durationMs) && durationMs >= 0 && durationMs <= 600_000;
}