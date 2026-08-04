export function formatEvent(event: any) {
  // Formats the custom jules.* events for the CLI output
  if (event?.type?.startsWith('jules.')) {
      return `[Jules] ${event.type}: Session ${event.julesSessionId || 'unknown'}`;
  }
  return null;
}
