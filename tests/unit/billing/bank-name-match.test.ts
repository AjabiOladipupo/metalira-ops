import { describe, expect, it } from "vitest";

import {
  matchCompanyName,
  matchPersonName,
  nameTokens,
  normaliseName,
  tokenSimilarity,
} from "@/lib/bank-name-match";

describe("normaliseName", () => {
  it("upper-cases, drops punctuation and accents, and spells & as AND", () => {
    expect(normaliseName("  Adebayo & Sons (Nig.) Ltd. ")).toBe("ADEBAYO AND SONS NIG LTD");
    expect(normaliseName("O'Neil-Okafor")).toBe("ONEIL OKAFOR");
    expect(normaliseName("Adébáyọ̀")).toBe("ADEBAYO");
    expect(nameTokens("")).toEqual([]);
  });
});

describe("tokenSimilarity", () => {
  it("scores exact, contained, misspelt and initial", () => {
    expect(tokenSimilarity("ADEYEMI", "ADEYEMI")).toBe(1);
    expect(tokenSimilarity("SEUN", "OLUWASEUN")).toBe(0.75);
    expect(tokenSimilarity("CHUKWUEMEKA", "CHUKWUEMKA")).toBe(0.75);
    expect(tokenSimilarity("J", "JOHN")).toBe(0.5);
    expect(tokenSimilarity("JOHN", "MARY")).toBe(0);
    expect(tokenSimilarity("OBI", "OBA")).toBe(0);
  });
});

describe("matchCompanyName", () => {
  const legal = "Adebayo Facility Services Ltd";

  it.each([
    "ADEBAYO FACILITY SERVICES LIMITED",
    "ADEBAYO FACILITY SVCS LTD",
    "ADEBAYO FACILITY SERVICES NIG LTD",
    "Adebayo Facility Services Nigeria Limited",
    "ADEBAYO FACILITY SERVICES",
    "ADEBAYO FACILITY LTD",
  ])("matches %s", (bank) => {
    expect(matchCompanyName(bank, [legal]).result).toBe("match");
  });

  it("treats & and AND alike, and words run together", () => {
    expect(
      matchCompanyName("SHIELD AND GUARD SECURITY LTD", ["Shield & Guard Security Limited"]).result,
    ).toBe("match");
    expect(matchCompanyName("SHIELDGUARD SECURITY LTD", ["Shield Guard Security Ltd"]).result).toBe(
      "match",
    );
    expect(matchCompanyName("KLEENWAY ENT", ["Kleenway Enterprises"]).result).toBe("match");
    expect(matchCompanyName("ZENITH CLEANING CO", ["Zenith Cleaning Company Ltd"]).result).toBe(
      "match",
    );
    expect(matchCompanyName("APEX INTL VENTURES", ["Apex International Ventures"]).result).toBe(
      "match",
    );
  });

  it("is near for a misspelling, a different generic word or a missing word", () => {
    expect(matchCompanyName("ADEBAYO FACILITTY SERVICES LTD", [legal]).result).toBe("near");
    expect(matchCompanyName("ADEBAYO FACILITY VENTURES LTD", [legal]).result).toBe("near");
    expect(matchCompanyName("ADEBAYO SERVICES LTD", ["Adebayo Facility Services Ltd"]).result).toBe(
      "near",
    );
  });

  it("refuses another business", () => {
    expect(matchCompanyName("OKONKWO TRADING LTD", [legal]).result).toBe("no_match");
    expect(matchCompanyName("GLOBAL SERVICES LTD", [legal]).result).toBe("no_match");
    expect(matchCompanyName("CHIDINMA OKAFOR", [legal]).result).toBe("no_match");
  });

  it("takes the best of the legal and trading names", () => {
    const m = matchCompanyName("SHIELDGUARDS SECURITY", [
      "Adebayo Holdings Ltd",
      "ShieldGuards Security",
      null,
    ]);
    expect(m).toMatchObject({ result: "match", expected: "ShieldGuards Security" });
    expect(matchCompanyName("ANYTHING", []).result).toBe("no_match");
  });
});

describe("matchPersonName", () => {
  const john = { firstName: "John", lastName: "Adeyemi" };

  it.each([
    "JOHN ADEYEMI",
    "ADEYEMI JOHN",
    "ADEYEMI JOHN OLUWASEUN",
    "ADEYEMI, JOHN O.",
    "MR JOHN ADEYEMI",
    "john  adeyemi",
  ])("matches %s in any order, with middle names and titles", (bank) => {
    expect(matchPersonName(bank, john).result).toBe("match");
  });

  it("matches realistic Nigerian names", () => {
    expect(
      matchPersonName("OKAFOR CHIDINMA BLESSING", { firstName: "Chidinma", lastName: "Okafor" })
        .result,
    ).toBe("match");
    expect(
      matchPersonName("ALHAJI MUSA IBRAHIM", { firstName: "Musa", lastName: "Ibrahim" }).result,
    ).toBe("match");
    expect(
      matchPersonName("OKAFOR-EZE NGOZI", { firstName: "Ngozi", lastName: "Okafor-Eze" }).result,
    ).toBe("match");
    expect(
      matchPersonName("OKAFOREZE NGOZI", { firstName: "Ngozi", lastName: "Okafor-Eze" }).result,
    ).toBe("match");
  });

  it("is near for an initial, a short form or a misspelling", () => {
    expect(matchPersonName("ADEYEMI J", john).result).toBe("near");
    expect(matchPersonName("ADEYEMI J O", john).result).toBe("near");
    expect(
      matchPersonName("SEUN BALOGUN", { firstName: "Oluwaseun", lastName: "Balogun" }).result,
    ).toBe("near");
    expect(
      matchPersonName("CHUKWUEMKA OBI", { firstName: "Chukwuemeka", lastName: "Obi" }).result,
    ).toBe("near");
    // The worker's own business account.
    expect(matchPersonName("JOHN ADEYEMI ENTERPRISES", john).result).toBe("near");
  });

  it("refuses someone else, even with the same surname or first name", () => {
    expect(matchPersonName("ADEYEMI MARY", john).result).toBe("no_match");
    expect(matchPersonName("JOHN OKAFOR", john).result).toBe("no_match");
    expect(matchPersonName("BLESSING NWOSU", john).result).toBe("no_match");
    expect(matchPersonName("ADEYEMI", john).result).toBe("no_match");
    expect(matchPersonName("", john).result).toBe("no_match");
  });

  it("names the expected name", () => {
    expect(matchPersonName("JOHN ADEYEMI", john).expected).toBe("John Adeyemi");
  });
});
