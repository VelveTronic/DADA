/**
 * Bridge configuration: `bridge.env` beside the bundle, NOT `.env.local`.
 *
 * The bridge deploys standalone onto the ERP server (`C:\dada\bridge\`), where
 * none of the app's env plumbing exists — no Next.js, no dotenv, no repo. So
 * this module owns the whole chain: read the file, parse it, validate it, and
 * fail CLOSED with a named error before a single row is written to the ERP.
 *
 * Two values in here are secrets (the Supabase service-role key and the SQL
 * password) and neither is ever allowed into a log line. `describeConfig` is the
 * only sanctioned way to print configuration, and `bridgeSecrets` hands the
 * logger the exact strings it must mask if one ever leaks through an error
 * message from a library we do not control.
 */
import { readFileSync } from "node:fs";
import type { config as MssqlConfig } from "mssql";

/** Named, machine-readable failure: the runbook can key remedies off `code`. */
export class BridgeConfigError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeConfigError";
    this.code = code;
  }
}

export interface BridgeConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  /** Host only. The `host,port` form is split by `parseServerAddress`. */
  wingestServer: string;
  /** Undefined means "let the driver use 1433" (or a named instance). */
  wingestPort: number | undefined;
  wingestDb: string;
  wingestUser: string;
  wingestPassword: string;
  /** `susuario.CODUSU` stamped on the pedido; the injector asserts it exists. */
  erpUser: string;
  /** Wingest "canal" — 'B' for the sales company the portal feeds. */
  can: string;
  /** Fiscal year short form, e.g. 26. */
  eje: number;
  /** Explicit escape hatch for a deliberate historical-year orders run. */
  allowHistoricalEje: boolean;
  /** The sole portal order an explicitly supervised historical run may claim. */
  historicalOrderId: string | null;
  /** Warehouse code used for lot picking and the line's CODALM. */
  alm: string;
  /**
   * Whether the lot ladder may WRITE an expired lot onto a pedido line.
   *
   * Default false, and that default is a food-safety decision rather than
   * caution: an expired pick puts a past FECCAD on paperwork a picker acts on,
   * and every control this portal can build fires in the office BEFORE the
   * conversion — there is none at the shelf, where staff read the lot code off
   * the document and pull that pallet. The expired candidate is still selected
   * and counted (`lotBlocked` on the orders heartbeat), so the owner decides
   * this from measured numbers instead of from an argument.
   */
  lotAllowExpired: boolean;
  /**
   * How many days past FECCAD an expired pick may be. 0 while the flag is off.
   *
   * Bounded 1..180 when it is on, and the bound is anchored on two real lots
   * rather than chosen for roundness: 100-002A's lot 037 (FECCAD 2026-03-30,
   * 144 days stale on 2026-08-21) is the stale-bookkeeping case worth
   * rescuing, and a 90-day cap would exclude it; 10-121's lot C26 (2022-08-24,
   * ~1,458 days, still carrying CANT=80) is the case no configuration may
   * reach, and it is unreachable at every legal setting here.
   */
  lotExpiredMaxDays: number;
  serfac: number;
  claimLimit: number;
  leaseSeconds: number;
}

const DEFAULTS = {
  BRIDGE_ERP_USER: "SFY",
  BRIDGE_CAN: "B",
  BRIDGE_EJE: 26,
  BRIDGE_ALLOW_HISTORICAL_EJE: false,
  BRIDGE_ALM: "00001",
  BRIDGE_LOT_ALLOW_EXPIRED: false,
  BRIDGE_LOT_EXPIRED_MAX_DAYS: 0,
  BRIDGE_SERFAC: 1,
  CLAIM_LIMIT: 20,
  LEASE_SECONDS: 300,
} as const;

/**
 * `bridge_claim_confirmed` raises BAD_CLAIM_LIMIT / BAD_LEASE_SECONDS outside
 * these ranges. Rejecting them here turns a remote 500 on every single run into
 * one legible startup error the operator can fix in `bridge.env`.
 */
const CLAIM_LIMIT_RANGE = { min: 1, max: 200 } as const;
const LEASE_SECONDS_RANGE = { min: 30, max: 3600 } as const;

/**
 * The clamp is the load-bearing half of the expired-lot pair. A fat-fingered
 * 3650 in `bridge.env` must fail at startup with
 * BAD_BRIDGE_LOT_EXPIRED_MAX_DAYS rather than quietly authorise four-year-old
 * stock; 180 is the ceiling because it admits the 144-day case this feature
 * exists for and excludes the 1,458-day one it must never reach (see
 * `lotExpiredMaxDays`).
 */
const LOT_EXPIRED_MAX_DAYS_RANGE = { min: 0, max: 180 } as const;

/** char(30) in `pedclica`; `portalRef` also asserts the built value fits. */
export const NUMPEDCLI_MAX_LENGTH = 30;

/** This bridge carries a service-role secret, so its destination is immutable. */
export const BRIDGE_SUPABASE_ORIGIN =
  "https://gudiykhngonoqsjoigza.supabase.co";

/**
 * KEY=VALUE lines. Deliberately minimal: no interpolation, no multi-line values,
 * no `export ` prefix — an operator editing this file in Notepad on a Windows
 * server should not have to know a shell dialect. Everything after the FIRST `=`
 * is the value, so a password containing `=` survives intact.
 *
 * A surrounding pair of quotes is stripped, because Notepad users add them and a
 * literal quote in a password would otherwise fail authentication with a message
 * that names nothing useful.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * `Server=host,port` is a SQL Server *client* convention that tedious does not
 * understand — it would try to resolve the literal host "localhost,50352" and
 * fail with a DNS error that says nothing about ports. Split it here.
 *
 * A backslash (`SERVER\SQLEXPRESS`) is left alone: that is a named instance,
 * resolved by the SQL Browser service, and it never carries a port.
 */
export function parseServerAddress(raw: string): {
  server: string;
  port: number | undefined;
} {
  const value = raw.trim();
  if (!value) {
    throw new BridgeConfigError("MISSING_WINGEST_SERVER", "WINGEST_SERVER is empty");
  }
  const comma = value.indexOf(",");
  if (comma < 0) return { server: value, port: undefined };

  const server = value.slice(0, comma).trim();
  const portText = value.slice(comma + 1).trim();
  const port = Number(portText);
  if (!server || !/^\d+$/.test(portText) || port < 1 || port > 65535) {
    throw new BridgeConfigError(
      "BAD_WINGEST_SERVER",
      `WINGEST_SERVER must be "host" or "host,port"; got "${raw}"`,
    );
  }
  return { server, port };
}

function requireValue(
  env: Record<string, string | undefined>,
  key: string,
): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new BridgeConfigError(`MISSING_${key}`, `${key} is required in bridge.env`);
  }
  return value;
}

function optionalText(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
  maxLength: number,
): string {
  const value = env[key]?.trim();
  if (!value) return fallback;
  if (value.length > maxLength) {
    throw new BridgeConfigError(
      `BAD_${key}`,
      `${key} must be at most ${maxLength} characters; got ${value.length}`,
    );
  }
  return value;
}

function optionalInteger(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  // Number("") is 0 and Number("12abc") is NaN; require the whole token to be
  // digits so "300s" or "20 " cannot silently become something else.
  if (!/^-?\d+$/.test(raw)) {
    throw new BridgeConfigError(`BAD_${key}`, `${key} must be an integer; got "${raw}"`);
  }
  const value = Number(raw);
  if (value < min || value > max) {
    throw new BridgeConfigError(
      `BAD_${key}`,
      `${key} must be between ${min} and ${max}; got ${value}`,
    );
  }
  return value;
}

/** Only the two literal boolean tokens are accepted — no truthy coercion. */
function optionalBoolean(
  env: Record<string, string | undefined>,
  key: string,
  fallback: boolean,
): boolean {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new BridgeConfigError(
    `BAD_${key}`,
    `${key} must be exactly "true" or "false"; got "${raw}"`,
  );
}

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
}

/** Canonical RFC UUID, or null when the optional setting is absent. */
function optionalUuid(
  env: Record<string, string | undefined>,
  key: string,
): string | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const canonical = raw.toLowerCase();
  if (!isCanonicalUuid(canonical)) {
    throw new BridgeConfigError(
      `BAD_${key}`,
      `${key} must be a standard hyphenated UUID; got "${raw}"`,
    );
  }
  return canonical;
}

/** Wingest CAN is a one- or two-character ASCII alphanumeric identifier. */
function bridgeCan(env: Record<string, string | undefined>): string {
  const raw = env.BRIDGE_CAN?.trim() || DEFAULTS.BRIDGE_CAN;
  const canonical = raw.toUpperCase();
  // Check the source as ASCII too: Unicode case folding can expand or map a
  // non-ASCII token into an apparently valid identifier (for example ß → SS).
  if (!/^[A-Za-z0-9]{1,2}$/.test(raw) || !/^[A-Z0-9]{1,2}$/.test(canonical)) {
    throw new BridgeConfigError(
      "BAD_BRIDGE_CAN",
      `BRIDGE_CAN must be 1-2 ASCII letters or digits; got "${raw}"`,
    );
  }
  return canonical;
}

/**
 * Pure: takes an environment map (from `bridge.env`, `process.env`, or a test)
 * and returns the validated config or throws. Nothing here reads a file or a
 * clock, so the whole validation surface is unit-testable.
 */
export function loadBridgeConfig(
  env: Record<string, string | undefined>,
): BridgeConfig {
  const supabaseUrlRaw = requireValue(env, "SUPABASE_URL");
  let supabaseUrl: string;
  try {
    const parsed = new URL(supabaseUrlRaw);
    if (
      parsed.origin !== BRIDGE_SUPABASE_ORIGIN ||
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      (parsed.pathname !== "" && parsed.pathname !== "/") ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("not the pinned project origin");
    }
    // Keep only the pinned origin. No path, credentials, custom port, query or
    // fragment can influence where the service-role Authorization header goes.
    supabaseUrl = BRIDGE_SUPABASE_ORIGIN;
  } catch {
    throw new BridgeConfigError(
      "BAD_SUPABASE_URL",
      `SUPABASE_URL must be exactly ${BRIDGE_SUPABASE_ORIGIN}`,
    );
  }

  const wingestDb = requireValue(env, "WINGEST_DB");
  // Shape check only. The two expected values are wg_test (sandbox) and wgdemo
  // (production), but the injector's real guard is `assertDatabase`, which
  // compares DB_NAME() against this value on the live connection — an enum here
  // would only add a cutover edit without adding safety.
  if (!/^[A-Za-z_][A-Za-z0-9_$#]{0,127}$/.test(wingestDb)) {
    throw new BridgeConfigError(
      "BAD_WINGEST_DB",
      `WINGEST_DB must be a SQL Server database name; got "${wingestDb}"`,
    );
  }

  const { server, port } = parseServerAddress(requireValue(env, "WINGEST_SERVER"));
  const allowHistoricalEje = optionalBoolean(
    env,
    "BRIDGE_ALLOW_HISTORICAL_EJE",
    DEFAULTS.BRIDGE_ALLOW_HISTORICAL_EJE,
  );
  const historicalOrderId = optionalUuid(env, "BRIDGE_HISTORICAL_ORDER_ID");
  if (allowHistoricalEje && historicalOrderId === null) {
    throw new BridgeConfigError(
      "MISSING_BRIDGE_HISTORICAL_ORDER_ID",
      "BRIDGE_HISTORICAL_ORDER_ID is required when BRIDGE_ALLOW_HISTORICAL_EJE=true",
    );
  }
  if (!allowHistoricalEje && historicalOrderId !== null) {
    throw new BridgeConfigError(
      "UNEXPECTED_BRIDGE_HISTORICAL_ORDER_ID",
      "BRIDGE_HISTORICAL_ORDER_ID requires BRIDGE_ALLOW_HISTORICAL_EJE=true",
    );
  }

  // The expired-lot pair, coupled exactly as the historical-ejercicio pair
  // above is, and for the same reason: a dangerous switch takes two deliberate
  // acts. Turning this one on forces the operator to write down, in a file, how
  // many days of expiry he is personally authorising — which is the difference
  // between a setting and a decision.
  const lotAllowExpired = optionalBoolean(
    env,
    "BRIDGE_LOT_ALLOW_EXPIRED",
    DEFAULTS.BRIDGE_LOT_ALLOW_EXPIRED,
  );
  const lotExpiredMaxDays = optionalInteger(
    env,
    "BRIDGE_LOT_EXPIRED_MAX_DAYS",
    DEFAULTS.BRIDGE_LOT_EXPIRED_MAX_DAYS,
    LOT_EXPIRED_MAX_DAYS_RANGE.min,
    LOT_EXPIRED_MAX_DAYS_RANGE.max,
  );
  if (lotAllowExpired && lotExpiredMaxDays === 0) {
    throw new BridgeConfigError(
      "MISSING_BRIDGE_LOT_EXPIRED_MAX_DAYS",
      `BRIDGE_LOT_EXPIRED_MAX_DAYS must be 1..${LOT_EXPIRED_MAX_DAYS_RANGE.max} when BRIDGE_LOT_ALLOW_EXPIRED=true`,
    );
  }
  if (!lotAllowExpired && lotExpiredMaxDays !== 0) {
    throw new BridgeConfigError(
      "UNEXPECTED_BRIDGE_LOT_EXPIRED_MAX_DAYS",
      "BRIDGE_LOT_EXPIRED_MAX_DAYS requires BRIDGE_LOT_ALLOW_EXPIRED=true",
    );
  }

  return {
    supabaseUrl,
    supabaseServiceRoleKey: requireValue(env, "SUPABASE_SERVICE_ROLE_KEY"),
    wingestServer: server,
    wingestPort: port,
    wingestDb,
    wingestUser: requireValue(env, "WINGEST_USER"),
    wingestPassword: requireValue(env, "WINGEST_PASSWORD"),
    // 4 chars is the `susuario.CODUSU` width; the sandbox default SFY is 3.
    erpUser: optionalText(env, "BRIDGE_ERP_USER", DEFAULTS.BRIDGE_ERP_USER, 4),
    // One canonical spelling makes the portal's (CAN,EJE,NUMPED) key dependable.
    can: bridgeCan(env),
    eje: optionalInteger(env, "BRIDGE_EJE", DEFAULTS.BRIDGE_EJE, 1, 9999),
    allowHistoricalEje,
    historicalOrderId,
    alm: optionalText(env, "BRIDGE_ALM", DEFAULTS.BRIDGE_ALM, 5),
    lotAllowExpired,
    lotExpiredMaxDays,
    serfac: optionalInteger(env, "BRIDGE_SERFAC", DEFAULTS.BRIDGE_SERFAC, 0, 999),
    claimLimit: optionalInteger(
      env,
      "CLAIM_LIMIT",
      DEFAULTS.CLAIM_LIMIT,
      CLAIM_LIMIT_RANGE.min,
      CLAIM_LIMIT_RANGE.max,
    ),
    leaseSeconds: optionalInteger(
      env,
      "LEASE_SECONDS",
      DEFAULTS.LEASE_SECONDS,
      LEASE_SECONDS_RANGE.min,
      LEASE_SECONDS_RANGE.max,
    ),
  };
}

/**
 * Read `bridge.env` and merge it UNDER the real process environment: a value
 * exported into the scheduled task's session wins over the file, which is how an
 * operator overrides one setting for a manual test run without editing (and
 * forgetting to revert) the deployed file.
 */
export function loadBridgeConfigFromFile(envPath: string): BridgeConfig {
  let text: string;
  try {
    text = readFileSync(envPath, "utf8");
  } catch (error) {
    throw new BridgeConfigError(
      "MISSING_BRIDGE_ENV",
      `cannot read ${envPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const fileEnv = parseEnvFile(text);
  const merged: Record<string, string | undefined> = { ...fileEnv };
  for (const key of Object.keys(fileEnv)) {
    const fromProcess = process.env[key];
    if (fromProcess) merged[key] = fromProcess;
  }
  for (const key of KNOWN_KEYS) {
    if (merged[key] === undefined && process.env[key]) merged[key] = process.env[key];
  }
  return loadBridgeConfig(merged);
}

const KNOWN_KEYS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "WINGEST_SERVER",
  "WINGEST_DB",
  "WINGEST_USER",
  "WINGEST_PASSWORD",
  "BRIDGE_ERP_USER",
  "BRIDGE_CAN",
  "BRIDGE_EJE",
  "BRIDGE_ALLOW_HISTORICAL_EJE",
  "BRIDGE_HISTORICAL_ORDER_ID",
  "BRIDGE_ALM",
  "BRIDGE_LOT_ALLOW_EXPIRED",
  "BRIDGE_LOT_EXPIRED_MAX_DAYS",
  "BRIDGE_SERFAC",
  "CLAIM_LIMIT",
  "LEASE_SECONDS",
] as const;

/**
 * The mssql pool configuration. TLS is mandatory. The current Wingest server
 * uses an internal/self-signed certificate, so certificate-chain trust remains
 * explicit until operations installs the enterprise CA.
 *
 * `useUTC: true` is tedious's default, pinned here because the injector depends
 * on it: a `datetime` read out of `stolot.FECCAD` and written straight back into
 * `pedclili.FECCAD` only round-trips unchanged while read and write agree on the
 * zone, and the ERP server's OS clock is in a different one (China) from the
 * business dates (Madrid).
 */
export function wingestPoolConfig(cfg: BridgeConfig): MssqlConfig {
  return {
    server: cfg.wingestServer,
    port: cfg.wingestPort,
    database: cfg.wingestDb,
    user: cfg.wingestUser,
    password: cfg.wingestPassword,
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
    options: {
      encrypt: true,
      trustServerCertificate: true,
      useUTC: true,
    },
    // One order at a time, one connection. A bigger pool would let two orders
    // interleave SERIALIZABLE transactions over the same counter rows and
    // deadlock for no gain: the queue is tiny and the job is sequential.
    pool: { max: 2, min: 0, idleTimeoutMillis: 30_000 },
  };
}

/** The exact strings the logger must never emit. Keep in sync with BridgeConfig. */
export function bridgeSecrets(cfg: BridgeConfig): string[] {
  return [cfg.supabaseServiceRoleKey, cfg.wingestPassword].filter(Boolean);
}

/**
 * The loggable projection of the config. Every field a startup line may print
 * lives here; the two secrets are structurally absent rather than masked, so a
 * future field cannot be added to the log by accident.
 */
export function describeConfig(
  cfg: BridgeConfig,
): Record<string, string | number | boolean | null> {
  return {
    supabaseUrl: cfg.supabaseUrl,
    wingestServer: cfg.wingestPort
      ? `${cfg.wingestServer},${cfg.wingestPort}`
      : cfg.wingestServer,
    wingestDb: cfg.wingestDb,
    wingestUser: cfg.wingestUser,
    erpUser: cfg.erpUser,
    can: cfg.can,
    eje: cfg.eje,
    allowHistoricalEje: cfg.allowHistoricalEje === true,
    historicalOrderId: cfg.historicalOrderId,
    alm: cfg.alm,
    // Neither is a secret and both MUST print on the startup line: an operator
    // asking "why did it pick an expired lot" has to see the flag state in the
    // same log file, and an auditor has to be able to prove the door was shut
    // on a given day.
    lotAllowExpired: cfg.lotAllowExpired === true,
    lotExpiredMaxDays: cfg.lotExpiredMaxDays,
    serfac: cfg.serfac,
    claimLimit: cfg.claimLimit,
    leaseSeconds: cfg.leaseSeconds,
  };
}
