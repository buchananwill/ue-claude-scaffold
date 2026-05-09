/**
 * Classifies Claude agent exit conditions by reading the structured terminal
 * `"type":"result"` event emitted by `claude -p --output-format stream-json`.
 * Falls back to a rapid-exit heuristic when no result event is present
 * (true crash, OOM kill, signal — process never reached the stream-json
 * terminal frame).
 */

export interface ClassifyExitInput {
  logTail: string;
  /** Whole seconds elapsed since agent start. Route schema enforces integer constraint. */
  elapsedSeconds: number;
  /** Total line count of the full log file, not the length of logTail. */
  outputLineCount: number;
  /**
   * The OS exit code of the claude process. Optional for backwards compat
   * with containers that pre-date the exit-code plumbing — when absent the
   * classifier falls back to the rapid-exit heuristic only.
   */
  exitCode?: number;
}

export interface ClassifyExitResult {
  abnormal: boolean;
  reason: string | null;
}

interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | null;
  stop_reason?: string | null;
  result?: string;
}

function findResultEvent(logTail: string): ClaudeResultEvent | null {
  const lines = logTail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.includes('"type":"result"')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === "result")
        return parsed as ClaudeResultEvent;
    } catch {
      // Malformed/truncated JSON — keep scanning earlier lines.
    }
  }
  return null;
}

export function classifyExit(input: ClassifyExitInput): ClassifyExitResult {
  const elapsedSeconds = Math.floor(input.elapsedSeconds);
  const outputLineCount = Math.floor(input.outputLineCount);

  // Authoritative path: stream-json emitted a terminal result event.
  const ev = findResultEvent(input.logTail);
  if (ev) {
    if (ev.is_error === false) return { abnormal: false, reason: null };
    if (ev.is_error === true) {
      const why = ev.api_error_status ?? ev.subtype ?? "unknown";
      return { abnormal: true, reason: `claude reported error (${why})` };
    }
  }

  // No result event — process didn't reach the stream-json terminal frame.
  // If the OS exit code is non-zero, the process crashed mid-run (OOM kill,
  // SIGKILL, network drop, segfault). This catches long-running failures
  // that the regex used to catch incidentally.
  if (typeof input.exitCode === "number" && input.exitCode !== 0) {
    return {
      abnormal: true,
      reason: `crashed without status (exit=${input.exitCode}, ${elapsedSeconds}s elapsed)`,
    };
  }

  // Exit code was 0 (or unknown). Only flag if too quick to have done anything
  // meaningful — catches the "binary failed to start" case.
  if (elapsedSeconds < 10 && outputLineCount < 5) {
    return {
      abnormal: true,
      reason: `rapid exit (${elapsedSeconds}s, ${outputLineCount} lines of output)`,
    };
  }

  return { abnormal: false, reason: null };
}
