const ESC = "\x1b";
const CSI = "\x9b";

const DA_PRIMARY_RESPONSE = "\x1b[?1;2c";
const DA_SECONDARY_RESPONSE = "\x1b[>0;0;0c";
const CPR_RESPONSE = "\x1b[1;1R";
const DSR_RESPONSE = "\x1b[0n";

const CSI_PATTERN_PREFIX = String.raw`(?:\u001b\[|\u009b)`;

function csiPattern(body: string): RegExp {
  return new RegExp(`^${CSI_PATTERN_PREFIX}${body}$`);
}

const QUERY_PATTERNS: Array<[RegExp, string]> = [
  [csiPattern("c"), DA_PRIMARY_RESPONSE],
  [csiPattern("\\?c"), DA_PRIMARY_RESPONSE],
  [csiPattern(">c"), DA_SECONDARY_RESPONSE],
  [csiPattern(">\\d*c"), DA_SECONDARY_RESPONSE],
  [csiPattern("6n"), CPR_RESPONSE],
  [csiPattern("5n"), DSR_RESPONSE],
];

const SWALLOWED_QUERY_PATTERNS = [csiPattern(">q"), csiPattern(">\\d*q")];

const RESPONSE_PATTERNS = [
  csiPattern("\\?\\d+(?:;\\d+)*c"),
  csiPattern(">\\d+(?:;\\d+)*[cq]"),
  csiPattern("\\d+(?:;\\d+)*R"),
  csiPattern("\\?\\d+(?:;\\d+)*\\$y"),
  csiPattern("\\d+n"),
];

interface ScanResult {
  forward: string;
  responses: string[];
  pending: string;
}

interface ParsedCsi {
  sequence: string;
  end: number;
}

function isEscapeStart(char: string | undefined): boolean {
  return char === ESC || char === CSI;
}

function isCsiFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function isCsiIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x3f;
}

function parseCsiSequence(input: string, start: number): ParsedCsi | null {
  const first = input[start];
  const csiOffset = first === CSI ? 1 : 2;

  if (first === ESC) {
    if (start + 1 >= input.length) {
      return null;
    }
    if (input[start + 1] !== "[") {
      return {
        sequence: input.slice(start, start + 1),
        end: start + 1,
      };
    }
  }

  for (let i = start + csiOffset; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (isCsiFinalByte(code)) {
      return {
        sequence: input.slice(start, i + 1),
        end: i + 1,
      };
    }
    if (!isCsiIntermediate(code)) {
      return {
        sequence: input.slice(start, start + 1),
        end: start + 1,
      };
    }
  }

  return null;
}

function getQueryAction(sequence: string): {
  matches: boolean;
  response: string | null;
} {
  for (const [pattern, response] of QUERY_PATTERNS) {
    if (pattern.test(sequence)) {
      return { matches: true, response };
    }
  }

  if (SWALLOWED_QUERY_PATTERNS.some((pattern) => pattern.test(sequence))) {
    return { matches: true, response: null };
  }

  return { matches: false, response: null };
}

function isTerminalResponse(sequence: string): boolean {
  return RESPONSE_PATTERNS.some((pattern) => pattern.test(sequence));
}

function scanTerminalStream(
  input: string,
  options: { stripQueries: boolean; stripResponses: boolean },
): ScanResult {
  let cursor = 0;
  let plainStart = 0;
  const responses: string[] = [];
  const parts: string[] = [];

  while (cursor < input.length) {
    if (!isEscapeStart(input[cursor])) {
      cursor += 1;
      continue;
    }

    const parsed = parseCsiSequence(input, cursor);
    if (!parsed) {
      break;
    }

    const queryAction = getQueryAction(parsed.sequence);
    const shouldStripQuery = options.stripQueries && queryAction.matches;
    const shouldStripResponse =
      options.stripResponses && isTerminalResponse(parsed.sequence);

    if (shouldStripQuery || shouldStripResponse) {
      if (cursor > plainStart) {
        parts.push(input.slice(plainStart, cursor));
      }
      if (queryAction.response) {
        responses.push(queryAction.response);
      }
      plainStart = parsed.end;
    }

    cursor = parsed.end;
  }

  if (plainStart < cursor) {
    parts.push(input.slice(plainStart, cursor));
  }

  return {
    forward: parts.join(""),
    responses,
    pending: input.slice(cursor),
  };
}

export function handleTerminalQueries(data: string): {
  filtered: string;
  responses: string[];
} {
  const result = scanTerminalStream(data, {
    stripQueries: true,
    stripResponses: false,
  });
  return {
    filtered: result.forward + result.pending,
    responses: result.responses,
  };
}

export function stripTerminalResponses(data: string): string {
  const result = scanTerminalStream(data, {
    stripQueries: false,
    stripResponses: true,
  });
  return result.forward + result.pending;
}

export class TerminalProtocolAdapter {
  private ptyPending = "";
  private clientPending = "";

  processPtyOutput(chunk: string): { forward: string; responses: string[] } {
    const result = scanTerminalStream(this.ptyPending + chunk, {
      stripQueries: true,
      stripResponses: true,
    });
    this.ptyPending = result.pending;
    return {
      forward: result.forward,
      responses: result.responses,
    };
  }

  processClientInput(chunk: string): string {
    const result = scanTerminalStream(this.clientPending + chunk, {
      stripQueries: true,
      stripResponses: true,
    });
    this.clientPending = result.pending;
    return result.forward;
  }
}
