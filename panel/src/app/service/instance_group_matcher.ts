import {
  MAX_CARRY_BUFFER,
  MAX_LINE_LENGTH,
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_WILDCARDS
} from "../entity/instance_group";

// Ready-pattern matching for instance groups.
//
// The pattern is NOT a regular expression: it is literal text plus the "*"
// wildcard (any run of characters). The pattern is split on "*" and the
// literal segments are located in order with String.indexOf, so matching is
// bounded by (pattern length x line length) and can never backtrack (ReDoS-safe).

// CSI sequences, OSC sequences and two-character escapes. All quantifiers are
// over disjoint character classes, so stripping is linear.
// eslint-disable-next-line no-control-regex
const ANSI_REGEX =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;

// Upper bound of raw text examined per feed() call, to keep one huge chunk
// from monopolising the event loop.
const MAX_CHUNK_LENGTH = 256 * 1024;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Validate a ready pattern. Returns an error code, or null if valid.
 */
export function validatePattern(
  pattern: unknown
): "type" | "length" | "wildcards" | "empty" | null {
  if (typeof pattern !== "string") return "type";
  if (pattern.length === 0) return "empty";
  if (pattern.length > MAX_PATTERN_LENGTH) return "length";
  let stars = 0;
  let literal = false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*") stars++;
    else literal = true;
  }
  if (stars > MAX_PATTERN_WILDCARDS) return "wildcards";
  // A pattern made only of wildcards would match every line
  if (!literal) return "empty";
  return null;
}

/**
 * Whether `line` contains the pattern (case-sensitive "contains" search; "*"
 * stands for any run of characters). ANSI codes are removed and the line is
 * truncated to MAX_LINE_LENGTH first.
 */
export function matchPattern(pattern: string, rawLine: string): boolean {
  if (validatePattern(pattern) !== null) return false;
  const line = stripAnsi(rawLine.slice(0, MAX_LINE_LENGTH * 2)).slice(0, MAX_LINE_LENGTH);
  return matchSegments(splitPattern(pattern), line);
}

function splitPattern(pattern: string): string[] {
  return pattern.split("*").filter((segment) => segment.length > 0);
}

function matchSegments(segments: string[], line: string): boolean {
  let position = 0;
  for (const segment of segments) {
    const index = line.indexOf(segment, position);
    if (index === -1) return false;
    position = index + segment.length;
  }
  return true;
}

/**
 * Incremental line matcher for a console stream. Feed it raw stdout chunks;
 * it returns true as soon as a line (or the current unterminated line) matches.
 * The carry buffer for the unterminated tail is capped at MAX_CARRY_BUFFER.
 */
export class PatternLineMatcher {
  private readonly segments: string[];
  private carry = "";

  constructor(pattern: string) {
    if (validatePattern(pattern) !== null) throw new Error("Invalid ready pattern");
    this.segments = splitPattern(pattern);
  }

  feed(chunk: string): boolean {
    if (typeof chunk !== "string" || chunk.length === 0) return false;
    const text = this.carry + chunk.slice(0, MAX_CHUNK_LENGTH);
    const lines = text.split(/\r\n|\n|\r/);
    // Last element is the unterminated tail (empty when text ends with a newline)
    const tail = lines.pop() ?? "";
    for (const line of lines) {
      if (this.testLine(line)) return true;
    }
    this.carry = tail.length > MAX_CARRY_BUFFER ? tail.slice(0, MAX_CARRY_BUFFER) : tail;
    // The unterminated tail may already hold the ready line (no trailing newline yet)
    return this.testLine(this.carry);
  }

  reset() {
    this.carry = "";
  }

  private testLine(rawLine: string): boolean {
    if (!rawLine) return false;
    const line = stripAnsi(rawLine.slice(0, MAX_LINE_LENGTH * 2)).slice(0, MAX_LINE_LENGTH);
    return matchSegments(this.segments, line);
  }
}
