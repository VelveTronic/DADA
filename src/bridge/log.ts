/**
 * Line-oriented logging to stderr AND a file beside the bundle. No dependencies:
 * the bridge is one esbuild output on a Windows server with no npm install, and
 * a logging library is the last thing that should be able to break a deploy.
 *
 * Two rules shape the format:
 *
 * 1. One event per line, ISO timestamp first, so the operator can read the tail
 *    of `bridge.log` in Notepad and paste a run into a chat window unedited.
 * 2. Secrets are masked on the way out. Nothing in this repo deliberately logs
 *    the service key or the SQL password, but errors from mssql, tedious and
 *    fetch are written by code we do not control, and one of them putting a
 *    connection string in a message would otherwise write the ERP password into
 *    a file the operator is about to paste into a chat window.
 */
import { appendFileSync } from "node:fs";

export type LogLevel = "INFO" | "WARN" | "ERROR";

/** Values a log line may carry. Objects are JSON-encoded, not [object Object]. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** An error plus the order it happened on — the pair an alert needs. */
  logError(error: unknown, fields?: LogFields): void;
}

export interface LoggerOptions {
  /** Absolute path of the log file; when absent the logger writes stderr only. */
  filePath?: string;
  /** Exact strings to mask everywhere in the output (see `bridgeSecrets`). */
  secrets?: readonly string[];
  /** Injectable for tests. */
  now?: () => Date;
}

/**
 * Replace every occurrence of every secret with `***`.
 *
 * Longest-first so that masking a short secret cannot leave a fragment of a
 * longer one behind, and empty strings are dropped because `split("")` would
 * shred the whole line.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * `key=value` pairs, with anything non-scalar JSON-encoded and anything
 * containing a space or a quote quoted. Undefined and null fields are dropped:
 * `numped=undefined` is noise, and its absence says the same thing.
 */
function formatFields(fields: LogFields): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    let text: string;
    if (typeof value === "string") {
      text = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      text = String(value);
    } else {
      try {
        text = JSON.stringify(value) ?? String(value);
      } catch {
        text = String(value);
      }
    }
    // Newlines would break the one-event-per-line contract that makes the file
    // greppable; a stack trace becomes a single (long) line instead.
    text = text.replace(/\r?\n/g, "\\n");
    parts.push(/[\s"]/.test(text) ? `${key}=${JSON.stringify(text)}` : `${key}=${text}`);
  }
  return parts.join(" ");
}

/** The whole line, pure and therefore testable. */
export function formatLogLine(
  timestamp: string,
  level: LogLevel,
  message: string,
  fields: LogFields = {},
): string {
  const tail = formatFields(fields);
  const head = `${timestamp} ${level} ${message.replace(/\r?\n/g, "\\n")}`;
  return tail ? `${head} ${tail}` : head;
}

/**
 * Flatten an unknown throw into loggable fields.
 *
 * `code` is picked up when present because every named error in this bridge
 * carries one (BridgeConfigError, PayloadError, InjectError, SupabaseError,
 * and mssql's own MSSQLError), and it is what an alert rule keys on. `cause` is
 * followed one level: the injector wraps step failures, and the wrapper alone
 * would name the order without naming what went wrong.
 */
export function describeError(error: unknown): LogFields {
  if (!(error instanceof Error)) return { error: String(error) };
  const fields: LogFields = { error: `${error.name}: ${error.message}` };
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") fields.code = code;
  const cause = error.cause;
  if (cause instanceof Error) {
    fields.cause = `${cause.name}: ${cause.message}`;
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string" || typeof causeCode === "number") {
      fields.causeCode = causeCode;
    }
  }
  if (error.stack) fields.stack = error.stack;
  return fields;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const { filePath, secrets = [], now = () => new Date() } = options;
  // One warning, not one per line: if the log file is unwritable (read-only
  // directory, file locked by an editor) the run must still go to stderr and
  // still inject orders — losing the file is not a reason to stop the ERP feed.
  let fileBroken = false;

  const write = (level: LogLevel, message: string, fields?: LogFields): void => {
    const line = redactSecrets(
      formatLogLine(now().toISOString(), level, message, fields),
      secrets,
    );
    process.stderr.write(`${line}\n`);
    if (!filePath || fileBroken) return;
    try {
      appendFileSync(filePath, `${line}\n`, "utf8");
    } catch (error) {
      fileBroken = true;
      const reason = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${now().toISOString()} WARN log file unavailable, continuing on stderr only ` +
          `path=${JSON.stringify(filePath)} reason=${JSON.stringify(redactSecrets(reason, secrets))}\n`,
      );
    }
  };

  return {
    info: (message, fields) => write("INFO", message, fields),
    warn: (message, fields) => write("WARN", message, fields),
    error: (message, fields) => write("ERROR", message, fields),
    logError: (error, fields) =>
      write("ERROR", "failed", { ...fields, ...describeError(error) }),
  };
}
