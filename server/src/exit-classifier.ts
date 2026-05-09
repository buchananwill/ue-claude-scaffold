/**
 * Classifies Claude agent exit conditions by scanning log output for
 * known failure signatures. Ported from entrypoint.sh _detect_abnormal_exit.
 */

export interface ClassifyExitInput {
  logTail: string;
  /** Whole seconds elapsed since agent start. Route schema enforces integer constraint. */
  elapsedSeconds: number;
  /** Total line count of the full log file, not the length of logTail. */
  outputLineCount: number;
}

export interface ClassifyExitResult {
  abnormal: boolean;
  reason: string | null;
}

// Auth failure patterns (case-insensitive)
const AUTH_PATTERN =
  /authentication_error|Invalid authentication credentials|Failed to authenticate/i;

// Token/session/rate exhaustion patterns (case-insensitive)
const TOKEN_PATTERN =
  /token.*limit|token.*exhaust|session.*limit|context.*limit|max.*token.*reached|rate.*limit.*exceeded|quota.*exceeded|billing.*error|overloaded_error/i;

interface ClaudeResultEvent {
  type: "result";
  subtype?: string;
  is_error?: boolean;
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

/**
 * Classify whether a Claude agent exit was abnormal based on log content
 * and runtime metrics. Returns `{ abnormal: true, reason }` if a known
 * failure signature is detected, or `{ abnormal: false, reason: null }`
 * for clean exits.
 */
export function classifyExit(input: ClassifyExitInput): ClassifyExitResult {
  const logTail = input.logTail;
  const elapsedSeconds = Math.floor(input.elapsedSeconds);
  const outputLineCount = Math.floor(input.outputLineCount);

  // Trust Claude's own self-report when stream-json emitted a terminal result
  // event. Supersedes the substring heuristics below, which produce false
  // positives on long orchestrator logs that incidentally mention "context
  // limit" / "session … limit" in agent prose.
  const resultEvent = findResultEvent(logTail);
  if (resultEvent) {
    if (resultEvent.is_error === false && resultEvent.subtype === "success") {
      return { abnormal: false, reason: null };
    }
    if (resultEvent.is_error === true) {
      return {
        abnormal: true,
        reason: `claude reported error (subtype=${resultEvent.subtype ?? "unknown"})`,
      };
    }
  }

  // Auth failure
  if (AUTH_PATTERN.test(logTail)) {
    return {
      abnormal: true,
      reason: "authentication failure (API credentials invalid or expired)",
    };
  }

  // Token/rate limit exhaustion
  if (TOKEN_PATTERN.test(logTail)) {
    return {
      abnormal: true,
      reason: "token or rate limit exhaustion",
    };
  }

  // Rapid exit heuristic: <10 seconds and <5 lines of output
  if (elapsedSeconds < 10 && outputLineCount < 5) {
    return {
      abnormal: true,
      reason: `rapid exit (${elapsedSeconds}s, ${outputLineCount} lines of output)`,
    };
  }

  return { abnormal: false, reason: null };
}
