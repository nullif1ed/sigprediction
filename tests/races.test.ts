import { describe, expect, it } from "vitest";
import { kalshiEventTickers, parseSigTitle, partyFromText, polymarketSlugs, raceId } from "@/lib/core/races";
import { fixture } from "./helpers";

describe("market normalization", () => {
  it("parses every SIG title format", () => {
    expect(parseSigTitle("Will the Democratic Party win the New Hampshire Senate?")).toEqual({ party: "D", office: "SENATE", state: "NH", cycle: 2026 });
    expect(parseSigTitle("Will the Republican Party win the NH-01 House race?")).toMatchObject({ party: "R", office: "HOUSE", state: "NH", district: 1 });
    expect(parseSigTitle("Will the Independent Party win the Nebraska Senate?")).toMatchObject({ party: "I", state: "NE" });
    expect(parseSigTitle("Will the Democratic Party win the U.S. House?")).toMatchObject({ office: "HOUSE_CONTROL", state: "US" });
    expect(parseSigTitle("Will the Republican Party win the Rhode Island Governor?")).toMatchObject({ office: "GOVERNOR", state: "RI" });
    expect(parseSigTitle("Will it rain?")).toBeNull();
  });

  it("parses all fixture markets", () => {
    const d = fixture<{ data: { title: string }[] }>("sig-markets.json");
    for (const m of d.data) expect(parseSigTitle(m.title), m.title).not.toBeNull();
  });

  it("groups both parties of one race together", () => {
    const a = parseSigTitle("Will the Democratic Party win the New Hampshire Senate?")!;
    const b = parseSigTitle("Will the Republican Party win the New Hampshire Senate?")!;
    expect(raceId(a)).toBe(raceId(b));
  });

  it("builds external identifiers pinned to the election cycle", () => {
    const r = parseSigTitle("Will the Republican Party win the NH-01 House race?")!;
    expect(polymarketSlugs(r)).toEqual(["nh-01-house-election-winner"]);
    expect(kalshiEventTickers(r)).toEqual(["HOUSENH1-26"]);
    const g = parseSigTitle("Will the Democratic Party win the New Hampshire Governor?")!;
    // Kalshi only lists GOVPARTYNH-28 (a different election); we must never match it.
    expect(kalshiEventTickers(g)).toEqual(["GOVPARTYNH-26"]);
  });

  it("extracts party from external wording", () => {
    expect(partyFromText("Will the Democrats win the New Hampshire Senate race in 2026?")).toBe("D");
    expect(partyFromText("Will a Republican win New Hampshire Governor?")).toBe("R");
    expect(partyFromText("Will Person A win?")).toBeNull();
  });
});

describe("Polymarket search fallback filters", () => {
  it("accepts only the plain winner event for the race", async () => {
    const { isWinnerEventFor } = await import("@/lib/core/races");
    const me2 = parseSigTitle("Will the Democratic Party win the ME-02 House race?")!;
    expect(isWinnerEventFor(me2, "ME-02 House Election Winner")).toBe(true);
    expect(isWinnerEventFor(me2, "ME-02 House Margin of Victory")).toBe(false);
    expect(isWinnerEventFor(me2, "ME-02 Republican Primary Winner")).toBe(false);
    const ca22 = parseSigTitle("Will the Republican Party win the CA-22 House race?")!;
    expect(isWinnerEventFor(ca22, "Which party will win the House race for the CA-22 seat?")).toBe(true);
    const mi = parseSigTitle("Will the Democratic Party win the Michigan Governor?")!;
    expect(isWinnerEventFor(mi, "Michigan Governor Winner 2026")).toBe(true);
    expect(isWinnerEventFor(mi, "Closest Governor's race")).toBe(false);
    expect(partyFromText("Will Option B win? Jocelyn Benson (D)")).toBe("D");
  });
});
