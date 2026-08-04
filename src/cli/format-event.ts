export function formatEvent(event: unknown) {
  if (typeof event === 'object' && event !== null) {
      const e = event as Record<string, unknown>;
      if (typeof e['type'] === 'string' && e['type'].startsWith('jules.')) {
          return `[Jules] ${e['type']}: Session ${e['julesSessionId'] || 'unknown'}`;
      }
  }
  return null;
}
