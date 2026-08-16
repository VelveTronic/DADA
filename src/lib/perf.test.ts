import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPerfLine, perfEnabled, perfRun, perfStep } from "./perf";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Long enough for a thenable handed to `Promise.resolve` to have been called. */
async function settleMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("formatPerfLine", () => {
  it("prints the route, every step and the total", () => {
    expect(
      formatPerfLine(
        "/zh/catalogo",
        [
          { label: "session", ms: 0.61 },
          { label: "profile", ms: 13.94 },
        ],
        40.42,
        7,
      ),
    ).toBe("[perf] #7 /zh/catalogo session=0.6 profile=13.9 total=40.4");
  });

  it("leaves the correlation id out when there is none", () => {
    expect(formatPerfLine("session", [], 12.3)).toBe(
      "[perf] session total=12.3",
    );
  });

  it("prints a step that never came back as ?", () => {
    expect(
      formatPerfLine("/zh/pedidos", [{ label: "orders", ms: Number.NaN }], 9),
    ).toBe("[perf] /zh/pedidos orders=? total=9.0");
  });
});

describe("perfEnabled", () => {
  it("is off unless PERF_LOG is exactly 1", () => {
    vi.stubEnv("PERF_LOG", undefined);
    expect(perfEnabled()).toBe(false);
    vi.stubEnv("PERF_LOG", "0");
    expect(perfEnabled()).toBe(false);
    vi.stubEnv("PERF_LOG", "true");
    expect(perfEnabled()).toBe(false);
    vi.stubEnv("PERF_LOG", "1");
    expect(perfEnabled()).toBe(true);
  });
});

/**
 * A supabase-js query builder is a thenable that sends nothing until something
 * subscribes to it, which is why the pages hand one straight to `step()` and
 * await the result later. If the instrument stopped subscribing when it is
 * switched off, turning `PERF_LOG` off would SERIALISE every page that was
 * parallel with it on — the one bug an instrument must not have.
 */
function lazyThenable<T>(value: T) {
  let subscribed = false;
  const thenable: PromiseLike<T> = {
    then(onfulfilled, onrejected) {
      subscribed = true;
      return Promise.resolve(value).then(onfulfilled, onrejected);
    },
  };
  return {
    get subscribed() {
      return subscribed;
    },
    thenable,
  };
}

describe("perfRun", () => {
  it("subscribes without being awaited, and stays silent, with logging off", async () => {
    vi.stubEnv("PERF_LOG", undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const work = lazyThenable("rows");
    const run = perfRun("/zh/catalogo");
    const pending = run.step("products", work.thenable);
    await settleMicrotasks();
    expect(work.subscribed).toBe(true);

    await expect(pending).resolves.toBe("rows");
    run.end();
    expect(log).not.toHaveBeenCalled();
  });

  it("subscribes without being awaited with logging on", async () => {
    vi.stubEnv("PERF_LOG", "1");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const work = lazyThenable("rows");
    const run = perfRun("/zh/catalogo");
    const pending = run.step("products", work.thenable);
    await settleMicrotasks();
    expect(work.subscribed).toBe(true);

    await expect(pending).resolves.toBe("rows");
    run.end();
  });

  it("logs one line per request, in the order the steps were issued", async () => {
    vi.stubEnv("PERF_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const run = perfRun("/zh/carrito");
    // Issued first, answered last: the line must still read products, settings.
    const slow = run.step<number>(
      "products",
      new Promise((resolve) => setTimeout(() => resolve(1), 5)),
    );
    const quick = run.step("settings", Promise.resolve(true));
    await Promise.all([slow, quick]);
    run.end();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^\[perf] #\d+ \/zh\/carrito products=[\d.]+ settings=[\d.]+ total=[\d.]+$/,
    );
  });

  it("prints once however often it is ended", async () => {
    vi.stubEnv("PERF_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const run = perfRun("/zh/perfil");
    await run.step("settings", Promise.resolve(true));
    run.end();
    run.end();

    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("perfStep", () => {
  it("subscribes and passes the value through with logging off", async () => {
    vi.stubEnv("PERF_LOG", undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const work = lazyThenable({ data: null });
    const pending = perfStep("profile", work.thenable);
    await settleMicrotasks();
    expect(work.subscribed).toBe(true);

    await expect(pending).resolves.toEqual({ data: null });
    expect(log).not.toHaveBeenCalled();
  });

  it("reports on a line of its own when no run owns the request", async () => {
    vi.stubEnv("PERF_LOG", "1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await perfStep("profile", Promise.resolve("row"));

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(
      /^\[perf] profile total=[\d.]+$/,
    );
  });
});
