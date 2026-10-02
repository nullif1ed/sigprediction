import type { Office, Party, RaceKey } from "./types";

export const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};
const NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]),
);

const PARTY: Record<string, Party> = { democratic: "D", republican: "R", independent: "I" };

const TITLE_RE = /^Will the (Democratic|Republican|Independent) Party win the (.+?)\??$/i;

/** Parse a SIG market title into a structured race key. Returns null when unrecognised. */
export function parseSigTitle(title: string, cycle = 2026): RaceKey | null {
  const m = TITLE_RE.exec(title.trim());
  if (!m) return null;
  const party = PARTY[m[1].toLowerCase()];
  const rest = m[2].trim();
  if (/^U\.?S\.? House$/i.test(rest)) return { party, office: "HOUSE_CONTROL", state: "US", cycle };
  if (/^U\.?S\.? Senate$/i.test(rest)) return { party, office: "SENATE_CONTROL", state: "US", cycle };
  const house = /^([A-Z]{2})-(\d{1,2}) House race$/i.exec(rest);
  if (house) {
    const st = house[1].toUpperCase();
    if (!STATES[st]) return null;
    return { party, office: "HOUSE", state: st, district: parseInt(house[2], 10), cycle };
  }
  const sw = /^(.+?) (Senate|Governor)$/i.exec(rest);
  if (sw) {
    const st = NAME_TO_CODE[sw[1].toLowerCase()];
    if (!st) return null;
    return { party, office: sw[2].toLowerCase() === "senate" ? "SENATE" : "GOVERNOR", state: st, cycle };
  }
  return null;
}

/** Key shared by every party's market in the same race (used to pair D/R markets). */
export function raceId(r: RaceKey): string {
  return `${r.cycle}:${r.office}:${r.state}${r.district ? "-" + r.district : ""}`;
}

/** Deterministic 0..1 hash of a race id: stable across restarts, so sampling never flaps a race
 * in and out from one tick to the next (and a race's legs always land on the same side). */
export function raceSampleScore(id: string): number {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function raceLabel(r: RaceKey): string {
  switch (r.office) {
    case "HOUSE_CONTROL":
      return "U.S. House control";
    case "SENATE_CONTROL":
      return "U.S. Senate control";
    case "HOUSE":
      return `${r.state}-${String(r.district).padStart(2, "0")} House`;
    default:
      return `${STATES[r.state]} ${r.office === "SENATE" ? "Senate" : "Governor"}`;
  }
}

const slugState = (st: string) => STATES[st].toLowerCase().replace(/\s+/g, "-");

/** Polymarket event slugs to try, most specific first. */
export function polymarketSlugs(r: RaceKey): string[] {
  switch (r.office) {
    case "HOUSE_CONTROL":
      return [`which-party-will-win-the-house-in-${r.cycle}`];
    case "SENATE_CONTROL":
      return [`which-party-will-win-the-senate-in-${r.cycle}`];
    case "HOUSE": {
      const d = String(r.district).padStart(2, "0");
      return [`${r.state.toLowerCase()}-${d}-house-election-winner`];
    }
    case "SENATE":
      return [`${slugState(r.state)}-senate-election-winner`];
    case "GOVERNOR":
      return [`${slugState(r.state)}-governor-winner-${r.cycle}`, `${slugState(r.state)}-governor-election-winner`];
  }
}

/** Free-text query used when no known Polymarket slug exists for a race. */
export function polymarketSearchQuery(r: RaceKey): string | null {
  switch (r.office) {
    case "HOUSE":
      return `${r.state}-${String(r.district).padStart(2, "0")} House`;
    case "SENATE":
      return `${STATES[r.state]} Senate election winner`;
    case "GOVERNOR":
      return `${STATES[r.state]} governor winner ${r.cycle}`;
    default:
      return null;
  }
}

/** True when an external event title is the plain winner market for this race. */
export function isWinnerEventFor(r: RaceKey, title: string): boolean {
  const t = title.toLowerCase();
  if (/primary|margin|combo|closer|closest|nominee|turnout|debate|sweep|popular vote| and |\bvs\.?\b|seats/.test(t)) return false;
  if (r.office === "HOUSE") {
    const d = String(r.district);
    return new RegExp(`\\b${r.state.toLowerCase()}[- ]?0?${d}\\b`).test(t) && /house|seat|district/.test(t);
  }
  const st = STATES[r.state]?.toLowerCase();
  return Boolean(st) && t.includes(st) && t.includes(r.office === "SENATE" ? "senate" : "governor");
}

/** Kalshi event tickers to try. Cycle suffix is mandatory so 2028 events never match. */
export function kalshiEventTickers(r: RaceKey): string[] {
  const yy = String(r.cycle).slice(2);
  switch (r.office) {
    case "HOUSE_CONTROL":
      return [`CONTROLH-${r.cycle}`];
    case "SENATE_CONTROL":
      return [`CONTROLS-${r.cycle}`];
    case "HOUSE":
      return [`HOUSE${r.state}${r.district}-${yy}`];
    case "SENATE":
      return [`SENATE${r.state}-${yy}`];
    case "GOVERNOR":
      return [`GOVPARTY${r.state}-${yy}`];
  }
}

/** Party mentioned in an external question / outcome label. */
export function partyFromText(text: string): Party | null {
  // Candidate labels such as "Jocelyn Benson (D)".
  const tag = /\((D|R|I)\)/.exec(text);
  if (tag) return tag[1] as Party;
  const t = text.toLowerCase();
  const d = /\bdemocrat(s|ic)?\b/.test(t);
  const r = /\brepublican(s)?\b|\bgop\b/.test(t);
  const i = /\bindependent\b/.test(t);
  if (d && !r && !i) return "D";
  if (r && !d && !i) return "R";
  if (i && !d && !r) return "I";
  return null;
}

export function officeNoun(o: Office): string {
  return o === "GOVERNOR" ? "governor" : o === "HOUSE" ? "house" : "senate";
}
