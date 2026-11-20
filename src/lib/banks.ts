/**
 * Nigerian banks and their bank codes, for the bank picker (slice 2.3b). Static and
 * browser-safe: the list is short, changes rarely, and must work offline in the forms.
 *
 * Source of the codes: Monnify's "Supported Banks" page (developers.monnify.com/docs/supported-banks,
 * read 19 Nov 2026), which lists the code each bank answers to on Monnify's account validation
 * (name enquiry) API, the API the account name check calls. For commercial, merchant and
 * non-interest banks these are the CBN three-digit codes (044 Access, 058 GTBank, 057 Zenith...);
 * microfinance banks, payment service banks and mobile money operators use their NIBSS
 * institution codes (50515 Moniepoint, 999992 OPay, 100033 PalmPay...).
 *
 * To add a bank, take its code from that page (or Monnify's Get Banks API) and add a unit test
 * row if it has aliases. Never change a code without checking the page: a wrong code sends the
 * name enquiry, and later the payroll bank file, to the wrong bank.
 */

export type BankKind =
  "commercial" | "merchant" | "non_interest" | "microfinance" | "payment_service" | "mobile_money";

export interface Bank {
  /** The bank code (CBN code or NIBSS institution code), digits only. */
  code: string;
  /** The name shown in the picker and stored as `bank_name`. */
  name: string;
  kind: BankKind;
  /** Other names people type or import files carry ("GTB", "Guaranty Trust"). */
  aliases?: readonly string[];
}

export const NIGERIAN_BANKS: readonly Bank[] = [
  // Commercial banks
  {
    code: "044",
    name: "Access Bank",
    kind: "commercial",
    aliases: ["Access", "Access Bank Plc", "Diamond Bank"],
  },
  { code: "023", name: "Citibank Nigeria", kind: "commercial", aliases: ["Citibank"] },
  { code: "050", name: "Ecobank Nigeria", kind: "commercial", aliases: ["Ecobank"] },
  { code: "070", name: "Fidelity Bank", kind: "commercial", aliases: ["Fidelity"] },
  {
    code: "011",
    name: "First Bank of Nigeria",
    kind: "commercial",
    aliases: ["First Bank", "FBN", "Firstbank"],
  },
  {
    code: "214",
    name: "First City Monument Bank (FCMB)",
    kind: "commercial",
    aliases: ["FCMB", "First City Monument Bank"],
  },
  { code: "103", name: "Globus Bank", kind: "commercial", aliases: ["Globus"] },
  {
    code: "058",
    name: "GTBank (Guaranty Trust Bank)",
    kind: "commercial",
    aliases: ["GTBank", "GTB", "GT Bank", "Guaranty Trust Bank", "GTCO"],
  },
  { code: "082", name: "Keystone Bank", kind: "commercial", aliases: ["Keystone"] },
  { code: "00107", name: "Optimus Bank", kind: "commercial", aliases: ["Optimus"] },
  { code: "907", name: "Parallex Bank", kind: "commercial", aliases: ["Parallex"] },
  { code: "076", name: "Polaris Bank", kind: "commercial", aliases: ["Polaris", "Skye Bank"] },
  {
    code: "105",
    name: "PremiumTrust Bank",
    kind: "commercial",
    aliases: ["Premium Trust", "Premium Trust Bank", "PremiumTrust"],
  },
  { code: "101", name: "Providus Bank", kind: "commercial", aliases: ["Providus"] },
  { code: "000034", name: "Signature Bank", kind: "commercial", aliases: ["Signature"] },
  {
    code: "221",
    name: "Stanbic IBTC Bank",
    kind: "commercial",
    aliases: ["Stanbic", "Stanbic IBTC", "IBTC"],
  },
  {
    code: "068",
    name: "Standard Chartered Bank",
    kind: "commercial",
    aliases: ["Standard Chartered", "StanChart"],
  },
  { code: "232", name: "Sterling Bank", kind: "commercial", aliases: ["Sterling"] },
  {
    code: "100",
    name: "SunTrust Bank",
    kind: "commercial",
    aliases: ["SunTrust", "Suntrust Bank Nigeria"],
  },
  {
    code: "102",
    name: "Titan Trust Bank",
    kind: "commercial",
    aliases: ["Titan", "Titan Bank", "Titan Trust"],
  },
  {
    code: "032",
    name: "Union Bank of Nigeria",
    kind: "commercial",
    aliases: ["Union Bank", "Union"],
  },
  {
    code: "033",
    name: "United Bank for Africa (UBA)",
    kind: "commercial",
    aliases: ["UBA", "United Bank for Africa"],
  },
  { code: "215", name: "Unity Bank", kind: "commercial", aliases: ["Unity"] },
  { code: "035", name: "Wema Bank", kind: "commercial", aliases: ["Wema", "ALAT", "ALAT by Wema"] },
  { code: "057", name: "Zenith Bank", kind: "commercial", aliases: ["Zenith"] },

  // Merchant banks
  {
    code: "946",
    name: "Coronation Merchant Bank",
    kind: "merchant",
    aliases: ["Coronation", "Coronation Bank"],
  },
  { code: "400001", name: "FSDH Merchant Bank", kind: "merchant", aliases: ["FSDH"] },
  { code: "060004", name: "Greenwich Merchant Bank", kind: "merchant", aliases: ["Greenwich"] },
  { code: "637", name: "Nova Merchant Bank", kind: "merchant", aliases: ["Nova", "Nova Bank"] },
  { code: "502", name: "Rand Merchant Bank", kind: "merchant", aliases: ["RMB", "Rand"] },

  // Non-interest banks
  { code: "301", name: "Jaiz Bank", kind: "non_interest", aliases: ["Jaiz"] },
  { code: "303", name: "Lotus Bank", kind: "non_interest", aliases: ["Lotus"] },
  { code: "302", name: "TAJBank", kind: "non_interest", aliases: ["Taj Bank", "TAJ"] },

  // Microfinance banks
  { code: "090134", name: "Accion Microfinance Bank", kind: "microfinance", aliases: ["Accion"] },
  { code: "090136", name: "Baobab Microfinance Bank", kind: "microfinance", aliases: ["Baobab"] },
  {
    code: "51318",
    name: "FairMoney Microfinance Bank",
    kind: "microfinance",
    aliases: ["FairMoney", "Fair Money"],
  },
  {
    code: "50211",
    name: "Kuda Microfinance Bank",
    kind: "microfinance",
    aliases: ["Kuda", "Kuda Bank"],
  },
  { code: "090177", name: "LAPO Microfinance Bank", kind: "microfinance", aliases: ["LAPO"] },
  { code: "51406", name: "Mint Microfinance Bank", kind: "microfinance", aliases: ["Mint"] },
  {
    code: "50515",
    name: "Moniepoint Microfinance Bank",
    kind: "microfinance",
    aliases: ["Moniepoint", "Moniepoint MFB", "TeamApt"],
  },
  { code: "947", name: "NPF Microfinance Bank", kind: "microfinance", aliases: ["NPF"] },
  {
    code: "090198",
    name: "Renmoney Microfinance Bank",
    kind: "microfinance",
    aliases: ["Renmoney"],
  },
  { code: "125", name: "Rubies Microfinance Bank", kind: "microfinance", aliases: ["Rubies"] },
  {
    code: "090286",
    name: "Safe Haven Microfinance Bank",
    kind: "microfinance",
    aliases: ["Safe Haven", "SafeHaven"],
  },
  { code: "51310", name: "Sparkle Microfinance Bank", kind: "microfinance", aliases: ["Sparkle"] },
  {
    code: "566",
    name: "VFD Microfinance Bank",
    kind: "microfinance",
    aliases: ["VFD", "V Bank", "VBank"],
  },
  { code: "940", name: "Carbon", kind: "microfinance", aliases: ["Carbon", "Paylater"] },

  // Payment service banks
  {
    code: "120001",
    name: "9PSB (9 Payment Service Bank)",
    kind: "payment_service",
    aliases: ["9PSB", "9 Payment Service Bank", "9mobile PSB"],
  },
  { code: "120002", name: "HopePSB", kind: "payment_service", aliases: ["Hope PSB", "Hope"] },
  { code: "120003", name: "MoMo PSB", kind: "payment_service", aliases: ["MoMo", "MTN MoMo"] },
  {
    code: "080002",
    name: "SmartCash PSB",
    kind: "payment_service",
    aliases: ["SmartCash", "Airtel SmartCash"],
  },

  // Mobile money operators
  {
    code: "999992",
    name: "OPay",
    kind: "mobile_money",
    aliases: ["OPay", "Paycom", "Opay Digital"],
  },
  { code: "100002", name: "Paga", kind: "mobile_money", aliases: ["Paga"] },
  { code: "100033", name: "PalmPay", kind: "mobile_money", aliases: ["PalmPay", "Palm Pay"] },
] as const satisfies readonly Bank[];

const BY_CODE = new Map(NIGERIAN_BANKS.map((bank) => [bank.code, bank]));

/** The bank with this code, or undefined. */
export function bankByCode(code: string | null | undefined): Bank | undefined {
  return code ? BY_CODE.get(code.trim()) : undefined;
}

/** True when `code` is in the list. */
export function isKnownBankCode(code: string): boolean {
  return BY_CODE.has(code);
}

/** Lower case, letters and digits only: "G.T. Bank" and "gtbank" compare equal. */
function squash(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const NOISE = /(plc|limited|ltd|nigeria|nig|bank|mfb|microfinancebank|microfinance)$/;

function squashBankName(text: string): string {
  let out = squash(text);
  // Strip trailing noise words one at a time: "Access Bank Plc" -> "access".
  for (let i = 0; i < 4 && NOISE.test(out) && out.replace(NOISE, "").length >= 2; i += 1) {
    out = out.replace(NOISE, "");
  }
  return out;
}

const NAME_INDEX: ReadonlyMap<string, Bank> = (() => {
  const index = new Map<string, Bank>();
  for (const bank of NIGERIAN_BANKS) {
    for (const name of [bank.name, ...(bank.aliases ?? [])]) {
      const key = squashBankName(name);
      if (key && !index.has(key)) index.set(key, bank);
    }
  }
  return index;
})();

/**
 * The bank a free-text name means, when it means exactly one ("GTB", "Guaranty Trust Bank Plc",
 * "First Bank"); undefined otherwise. For pre-selecting the picker from a name saved before
 * slice 2.3b or from an import file. Never used to pick a bank without a person confirming it.
 */
export function bankFromName(name: string | null | undefined): Bank | undefined {
  if (!name) return undefined;
  return NAME_INDEX.get(squashBankName(name));
}

/**
 * Banks matching what was typed in the picker, best first: name or alias starting with the
 * query, then containing it, then the code. An empty query gives the whole list.
 */
export function searchBanks(query: string, banks: readonly Bank[] = NIGERIAN_BANKS): Bank[] {
  const q = squash(query);
  if (!q) return [...banks];
  const scored: { bank: Bank; score: number; index: number }[] = [];
  banks.forEach((bank, index) => {
    const names = [bank.name, ...(bank.aliases ?? [])].map(squash);
    let score = 0;
    if (names.some((n) => n.startsWith(q))) score = 3;
    else if (names.some((n) => n.includes(q))) score = 2;
    else if (bank.code.startsWith(q)) score = 1;
    if (score > 0) scored.push({ bank, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.bank);
}
