import { describe, expect, it } from "vitest";
import {
  BRIDGE_SUPABASE_ORIGIN,
  BridgeConfigError,
  bridgeSecrets,
  describeConfig,
  loadBridgeConfig,
  parseEnvFile,
  parseServerAddress,
  wingestPoolConfig,
} from "./config";

const MINIMAL = {
  SUPABASE_URL: "https://gudiykhngonoqsjoigza.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_do_not_log",
  WINGEST_SERVER: "localhost,50352",
  WINGEST_DB: "wg_test",
  WINGEST_USER: "dada_bridge",
  WINGEST_PASSWORD: "correct horse battery staple",
};
const HISTORICAL_ORDER_ID = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

describe("parseEnvFile", () => {
  it("reads KEY=VALUE, skipping blanks and comments", () => {
    expect(
      parseEnvFile(["# a comment", "", "A=1", "  B = two  ", "C=", "novalue"].join("\n")),
    ).toEqual({ A: "1", B: "two", C: "" });
  });

  it("keeps everything after the first = so a password may contain one", () => {
    expect(parseEnvFile("WINGEST_PASSWORD=a=b=c").WINGEST_PASSWORD).toBe("a=b=c");
  });

  it("strips a matched pair of surrounding quotes", () => {
    expect(parseEnvFile('A="quoted value"').A).toBe("quoted value");
    expect(parseEnvFile("B='single'").B).toBe("single");
    // Not a matched pair: the quote is part of the password.
    expect(parseEnvFile('C="unbalanced').C).toBe('"unbalanced');
  });

  it("handles CRLF, which is what Notepad writes on the ERP server", () => {
    expect(parseEnvFile("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });
});

describe("parseServerAddress", () => {
  it("splits the host,port form tedious cannot parse itself", () => {
    expect(parseServerAddress("localhost,50352")).toEqual({
      server: "localhost",
      port: 50352,
    });
  });

  it("leaves a bare host and a named instance alone", () => {
    expect(parseServerAddress("localhost")).toEqual({ server: "localhost", port: undefined });
    expect(parseServerAddress("SERVER\\SQLEXPRESS")).toEqual({
      server: "SERVER\\SQLEXPRESS",
      port: undefined,
    });
  });

  it("rejects a malformed address rather than resolving nonsense", () => {
    expect(() => parseServerAddress("localhost,")).toThrow(BridgeConfigError);
    expect(() => parseServerAddress("localhost,abc")).toThrow(BridgeConfigError);
    expect(() => parseServerAddress("localhost,99999")).toThrow(BridgeConfigError);
    expect(() => parseServerAddress(",50352")).toThrow(BridgeConfigError);
    expect(() => parseServerAddress("  ")).toThrow(BridgeConfigError);
  });
});

describe("loadBridgeConfig", () => {
  it("applies the documented defaults", () => {
    expect(loadBridgeConfig(MINIMAL)).toMatchObject({
      erpUser: "SFY",
      can: "B",
      eje: 26,
      allowHistoricalEje: false,
      historicalOrderId: null,
      alm: "00001",
      serfac: 1,
      claimLimit: 20,
      leaseSeconds: 300,
      wingestServer: "localhost",
      wingestPort: 50352,
    });
  });

  it("fails closed with a named code for every missing required value", () => {
    for (const key of Object.keys(MINIMAL)) {
      const env = { ...MINIMAL, [key]: "" };
      const error = (() => {
        try {
          loadBridgeConfig(env);
          return null;
        } catch (caught) {
          return caught as BridgeConfigError;
        }
      })();
      expect(error, `${key} should be required`).toBeInstanceOf(BridgeConfigError);
      expect(error?.code).toContain(key);
    }
  });

  it("normalises the Supabase URL so paths never double up on the slash", () => {
    expect(
      loadBridgeConfig({ ...MINIMAL, SUPABASE_URL: `${BRIDGE_SUPABASE_ORIGIN}/` })
        .supabaseUrl,
    ).toBe(BRIDGE_SUPABASE_ORIGIN);
  });

  it("pins the service-role credential to this exact HTTPS project origin", () => {
    for (const invalid of [
      "not a url",
      "http://gudiykhngonoqsjoigza.supabase.co",
      "https://otherproject.supabase.co",
      "https://gudiykhngonoqsjoigza.supabase.co:444",
      "https://user:pass@gudiykhngonoqsjoigza.supabase.co",
      "https://gudiykhngonoqsjoigza.supabase.co/rest/v1",
      "https://gudiykhngonoqsjoigza.supabase.co?redirect=evil",
      "https://gudiykhngonoqsjoigza.supabase.co#fragment",
    ]) {
      expect(() => loadBridgeConfig({ ...MINIMAL, SUPABASE_URL: invalid })).toThrow(
        /BAD_SUPABASE_URL|SUPABASE_URL/,
      );
    }
  });

  it("rejects a database name that is not an identifier", () => {
    expect(() => loadBridgeConfig({ ...MINIMAL, WINGEST_DB: "wg test;DROP" })).toThrow(
      BridgeConfigError,
    );
    expect(loadBridgeConfig({ ...MINIMAL, WINGEST_DB: "wgdemo" }).wingestDb).toBe("wgdemo");
  });

  it("keeps CLAIM_LIMIT and LEASE_SECONDS inside the RPC's own bounds", () => {
    // bridge_claim_confirmed raises BAD_CLAIM_LIMIT / BAD_LEASE_SECONDS outside
    // these, and it is far better to learn that at startup than once per run.
    expect(() => loadBridgeConfig({ ...MINIMAL, CLAIM_LIMIT: "0" })).toThrow(/CLAIM_LIMIT/);
    expect(() => loadBridgeConfig({ ...MINIMAL, CLAIM_LIMIT: "201" })).toThrow(/CLAIM_LIMIT/);
    expect(() => loadBridgeConfig({ ...MINIMAL, LEASE_SECONDS: "29" })).toThrow(/LEASE_SECONDS/);
    expect(() => loadBridgeConfig({ ...MINIMAL, LEASE_SECONDS: "3601" })).toThrow(/LEASE_SECONDS/);
    expect(loadBridgeConfig({ ...MINIMAL, CLAIM_LIMIT: "200" }).claimLimit).toBe(200);
  });

  it("rejects a non-integer where an integer is required", () => {
    expect(() => loadBridgeConfig({ ...MINIMAL, LEASE_SECONDS: "300s" })).toThrow(/LEASE_SECONDS/);
    expect(() => loadBridgeConfig({ ...MINIMAL, BRIDGE_EJE: "twenty-six" })).toThrow(/BRIDGE_EJE/);
  });

  it("accepts only literal true/false for the historical-year escape hatch", () => {
    const historical = loadBridgeConfig({
      ...MINIMAL,
      BRIDGE_ALLOW_HISTORICAL_EJE: "true",
      BRIDGE_HISTORICAL_ORDER_ID: HISTORICAL_ORDER_ID,
    });
    expect(historical.allowHistoricalEje).toBe(true);
    expect(historical.historicalOrderId).toBe(HISTORICAL_ORDER_ID.toLowerCase());
    expect(
      loadBridgeConfig({ ...MINIMAL, BRIDGE_ALLOW_HISTORICAL_EJE: "false" })
        .allowHistoricalEje,
    ).toBe(false);
    for (const invalid of ["1", "yes", "TRUE", "False"]) {
      expect(() =>
        loadBridgeConfig({ ...MINIMAL, BRIDGE_ALLOW_HISTORICAL_EJE: invalid }),
      ).toThrow(/BRIDGE_ALLOW_HISTORICAL_EJE/);
    }
  });

  it("requires the historical switch and one canonical order UUID together", () => {
    expect(() =>
      loadBridgeConfig({ ...MINIMAL, BRIDGE_ALLOW_HISTORICAL_EJE: "true" }),
    ).toThrow(/BRIDGE_HISTORICAL_ORDER_ID/);
    expect(() =>
      loadBridgeConfig({
        ...MINIMAL,
        BRIDGE_ALLOW_HISTORICAL_EJE: "false",
        BRIDGE_HISTORICAL_ORDER_ID: HISTORICAL_ORDER_ID,
      }),
    ).toThrow(/BRIDGE_HISTORICAL_ORDER_ID/);
  });

  it("rejects a historical target that is not a standard hyphenated UUID", () => {
    for (const invalid of [
      "aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
      "{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}",
      "00000000-0000-0000-0000-000000000000",
      "aaaaaaaa-aaaa-9aaa-8aaa-aaaaaaaaaaaa",
      "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa",
    ]) {
      expect(() =>
        loadBridgeConfig({
          ...MINIMAL,
          BRIDGE_ALLOW_HISTORICAL_EJE: "true",
          BRIDGE_HISTORICAL_ORDER_ID: invalid,
        }),
      ).toThrow(/BRIDGE_HISTORICAL_ORDER_ID/);
    }
  });

  it("rejects an ERP user wider than susuario.CODUSU", () => {
    expect(() => loadBridgeConfig({ ...MINIMAL, BRIDGE_ERP_USER: "TOOLONG" })).toThrow(
      /BRIDGE_ERP_USER/,
    );
    expect(loadBridgeConfig({ ...MINIMAL, BRIDGE_ERP_USER: "ABCD" }).erpUser).toBe("ABCD");
  });

  it("normalises BRIDGE_CAN to the uppercase ERP identity spelling", () => {
    expect(loadBridgeConfig({ ...MINIMAL, BRIDGE_CAN: " b " }).can).toBe("B");
    expect(loadBridgeConfig({ ...MINIMAL, BRIDGE_CAN: "a1" }).can).toBe("A1");
  });

  it("rejects non-ASCII, punctuation and values that expand during CAN uppercasing", () => {
    for (const invalid of ["ß", "é", "A-", "ABC", "中"]) {
      expect(() => loadBridgeConfig({ ...MINIMAL, BRIDGE_CAN: invalid })).toThrow(
        /BRIDGE_CAN/,
      );
    }
  });
});

describe("wingestPoolConfig", () => {
  const cfg = loadBridgeConfig(MINIMAL);

  it("mirrors the sandbox-validated connection string", () => {
    const pool = wingestPoolConfig(cfg);
    expect(pool.server).toBe("localhost");
    expect(pool.port).toBe(50352);
    expect(pool.database).toBe("wg_test");
    expect(pool.options?.encrypt).toBe(true);
    expect(pool.options?.trustServerCertificate).toBe(true);
  });

  it("pins useUTC, which the FECCAD round-trip depends on", () => {
    expect(wingestPoolConfig(cfg).options?.useUTC).toBe(true);
  });
});

describe("secret hygiene", () => {
  const cfg = loadBridgeConfig(MINIMAL);

  it("names both secrets for the logger to mask", () => {
    expect(bridgeSecrets(cfg)).toEqual([
      "sb_secret_do_not_log",
      "correct horse battery staple",
    ]);
  });

  it("leaves both secrets structurally out of the loggable projection", () => {
    const described = JSON.stringify(describeConfig(cfg));
    expect(described).not.toContain("sb_secret_do_not_log");
    expect(described).not.toContain("correct horse battery staple");
    expect(described).toContain("wg_test");
    expect(described).toContain("localhost,50352");
  });
});
