import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseJulesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ content: line }] as unknown as TranscriptEntry[];
}
