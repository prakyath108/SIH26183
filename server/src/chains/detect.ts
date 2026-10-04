import type { Chain } from "../types.js";

/**
 * Identifier detection. Detection is a heuristic on shape only; it says what an
 * identifier *could* be, never what it *is*. A wrong guess surfaces as an
 * upstream lookup error the investigator can correct.
 */

const PATTERNS = {
  bitcoin: [
    { re: /^(bc1)[023456789acdefghjklmnpqrstuvwxyz]{11,71}$/i, kind: "bech32" },
    { re: /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/, kind: "base58" }
  ],
  ethereum: [{ re: /^0x[0-9a-fA-F]{40}$/, kind: "evm" }],
  tron: [{ re: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, kind: "base58" }],
  polygon: [{ re: /^0x[0-9a-fA-F]{40}$/, kind: "evm" }]
} satisfies Record<string, { re: RegExp; kind: string }[]>;

export interface Detection {
  input: string;
  type: "address" | "tx";
  chain: Chain;
  encoding: string;
  /** Chains where the same shape is also valid; the UI asks the user to disambiguate. */
  ambiguousChains: Chain[];
  normalized: string;
}

const TX_HASH_PATTERNS: { chain: Chain; re: RegExp }[] = [
  { chain: "bitcoin", re: /^[0-9a-fA-F]{64}$/ },
  { chain: "ethereum", re: /^0x[0-9a-fA-F]{64}$/ },
  { chain: "tron", re: /^[0-9a-fA-F]{64}$/ }
];

function normalizeErc20(address: string): string {
  return address.toLowerCase();
}

export function detect(raw: string): Detection | null {
  const input = raw.trim();
  if (!input) return null;

  for (const { chain, re } of TX_HASH_PATTERNS) {
    if (re.test(input)) {
      const normalized = chain === "bitcoin" ? input.toLowerCase() : input.toLowerCase();
      return { input, type: "tx", chain, encoding: "hex", ambiguousChains: ambiguousTxChains(input), normalized };
    }
  }

  // Bitcoin bech32 and base58 first (no shared prefix with others)
  for (const [chain, rules] of Object.entries(PATTERNS)) {
    for (const rule of rules) {
      if (rule.re.test(input)) {
        return {
          input,
          type: "address",
          chain: chain as Chain,
          encoding: rule.kind,
          ambiguousChains: ambiguousAddressChains(input, chain as Chain),
          normalized: chain === "ethereum" || chain === "polygon" ? normalizeErc20(input) : input
        };
      }
    }
  }

  return null;
}

function ambiguousTxChains(input: string): Chain[] {
  const matches: Chain[] = [];
  for (const { chain, re } of TX_HASH_PATTERNS) if (re.test(input)) matches.push(chain);
  return matches;
}

function ambiguousAddressChains(input: string, matched: Chain): Chain[] {
  const matches: Chain[] = [];
  for (const [chain, rules] of Object.entries(PATTERNS)) {
    if (rules.some((r) => r.re.test(input))) matches.push(chain as Chain);
  }
  return matches.length > 1 ? matches.filter((m) => m !== matched) : [];
}

export function isValidAddress(chain: Chain, address: string): boolean {
  const rules = PATTERNS[chain as keyof typeof PATTERNS];
  if (!rules) return false;
  return rules.some((r) => r.re.test(address));
}

export function isValidTxHash(chain: Chain, hash: string): boolean {
  switch (chain) {
    case "bitcoin":
      return /^[0-9a-f]{64}$/i.test(hash);
    case "ethereum":
    case "polygon":
    case "tron":
      return /^0x[0-9a-f]{64}$/i.test(hash) || /^[0-9a-f]{64}$/i.test(hash);
    default:
      return false;
  }
}

export const CHAIN_META: Record<Chain, { name: string; symbol: string; explorer: string; addressExample: string; txExample: string }> = {
  bitcoin: {
    name: "Bitcoin",
    symbol: "BTC",
    explorer: "https://mempool.space",
    addressExample: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
    txExample: "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"
  },
  ethereum: {
    name: "Ethereum",
    symbol: "ETH",
    explorer: "https://etherscan.io",
    addressExample: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    txExample: "0x5c504ed432cb5113b7f288aae8e09f015f2c3aa2a0c2b1e5cd35b4e1b2a7d0e9c1"
  },
  tron: {
    name: "Tron",
    symbol: "TRX",
    explorer: "https://tronscan.org",
    addressExample: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    txExample: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"
  },
  polygon: {
    name: "Polygon",
    symbol: "POL",
    explorer: "https://polygonscan.com",
    addressExample: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    txExample: "0x5c504ed432cb5113b7f288aae8e09f015f2c3aa2a0c2b1e5cd35b4e1b2a7d0e9c1"
  },
  unknown: { name: "Unknown", symbol: "?", explorer: "", addressExample: "", txExample: "" }
};

/** Human label for a chain value coming from the DB or a user form. */
export function chainName(chain: string): string {
  return CHAIN_META[chain as Chain]?.name ?? chain;
}
