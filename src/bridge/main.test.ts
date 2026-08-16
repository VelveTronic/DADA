import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_FILE, JOBS, LOG_FILE, USAGE, parseArgv, resolveBridgeDir } from "./main";

describe("parseArgv", () => {
  it("accepts each job exactly once", () => {
    for (const job of JOBS) {
      expect(parseArgv([job])).toEqual({ kind: "job", job });
    }
  });

  it("accepts --help", () => {
    expect(parseArgv(["--help"])).toEqual({ kind: "help" });
  });

  it("treats NO argument as an error, not as help", () => {
    // A scheduled task created without its argument has to fail visibly rather
    // than print usage and exit 0 forever.
    const outcome = parseArgv([]);
    expect(outcome.kind).toBe("error");
  });

  it("rejects an unknown command and names it", () => {
    const outcome = parseArgv(["order"]);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toContain('"order"');
  });

  it("rejects a second argument", () => {
    const outcome = parseArgv(["orders", "--dry-run"]);
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toContain("exactly one");
  });

  it("rejects a job repeated", () => {
    expect(parseArgv(["orders", "orders"]).kind).toBe("error");
  });

  it("does not accept abbreviations, flags or casing variants", () => {
    for (const argv of [["-h"], ["help"], ["--orders"], ["ORDERS"], ["orders "]]) {
      expect(parseArgv(argv).kind).toBe("error");
    }
  });
});

describe("USAGE", () => {
  it("names every command the parser accepts", () => {
    for (const job of JOBS) expect(USAGE).toContain(job);
    expect(USAGE).toContain("--help");
  });

  it("tells the operator where config and logs live", () => {
    expect(USAGE).toContain(ENV_FILE);
    expect(USAGE).toContain(LOG_FILE);
  });
});

describe("resolveBridgeDir", () => {
  it("is the directory of the script node was given, not the working directory", () => {
    const script = resolve("C:/dada/bridge/dada-bridge.js");
    expect(resolveBridgeDir(script)).toBe(dirname(script));
  });

  it("resolves a relative script path against the working directory", () => {
    expect(resolveBridgeDir("dist/dada-bridge.js")).toBe(
      dirname(resolve("dist/dada-bridge.js")),
    );
  });

  it("falls back to the working directory when node was given no script", () => {
    expect(resolveBridgeDir(undefined)).toBe(process.cwd());
  });
});
