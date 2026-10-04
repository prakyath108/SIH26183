import type { Chain } from "../types.js";
import type { NormalizedTransaction } from "../chains/base.js";

/**
 * Known cross-chain bridge contracts and their identifiers.
 * This list can be extended as new bridges are deployed.
 */
export interface BridgeContract {
  chain: Chain;
  address: string;
  name: string;
  type: "lock_mint" | "burn_mint" | "lock_unlock" | "atomic_swap";
  destinationChains: Chain[];
}

/**
 * Well-known bridge contracts as of 2024-2025.
 * These should be updated as new bridges are deployed.
 */
export const KNOWN_BRIDGES: BridgeContract[] = [
  // Ethereum -> Polygon
  {
    chain: "ethereum",
    address: "0x0000000000000000000000000000000000001010",
    name: "Polygon Bridge (PoS)",
    type: "lock_mint",
    destinationChains: ["polygon"]
  },
  {
    chain: "ethereum",
    address: "0x40ec5ce0f8287251c820e5432b74d4f1d3ad4942",
    name: "Polygon Bridge (Plasma)",
    type: "lock_mint",
    destinationChains: ["polygon"]
  },
  // Ethereum -> Arbitrum
  {
    chain: "ethereum",
    address: "0x8315177aB2FE759764D580F461cC5f2d3b161C87",
    name: "Arbitrum Bridge",
    type: "lock_mint",
    destinationChains: ["ethereum"] // Arbitrum is L2 on Ethereum
  },
  // Ethereum -> Optimism
  {
    chain: "ethereum",
    address: "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
    name: "Optimism Bridge",
    type: "lock_mint",
    destinationChains: ["ethereum"]
  },
  // Ethereum -> Base
  {
    chain: "ethereum",
    address: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e",
    name: "Base Bridge",
    type: "lock_mint",
    destinationChains: ["ethereum"]
  },
  // Ethereum -> Tron (via JustBridge or similar)
  {
    chain: "ethereum",
    address: "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0",
    name: "Multichain (Anyswap)",
    type: "lock_mint",
    destinationChains: ["tron", "polygon", "ethereum"]
  },
  // Polygon -> Ethereum
  {
    chain: "polygon",
    address: "0x40ec5ce0f8287251c820e5432b74d4f1d3ad4942",
    name: "Polygon Bridge (Plasma Exit)",
    type: "burn_mint",
    destinationChains: ["ethereum"]
  },
  {
    chain: "polygon",
    address: "0x0000000000000000000000000000000000001010",
    name: "Polygon Bridge (PoS Exit)",
    type: "lock_unlock",
    destinationChains: ["ethereum"]
  },
  // Bitcoin bridges (via wrapped tokens)
  {
    chain: "ethereum",
    address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    name: "WBTC Bridge",
    type: "lock_mint",
    destinationChains: ["bitcoin"]
  },
  {
    chain: "ethereum",
    address: "0x8F3Cf7ad23Cd3CaDbD9735AFf958023239c6A063",
    name: "RenBTC Bridge",
    type: "lock_mint",
    destinationChains: ["bitcoin"]
  },
  // Wormhole (multi-chain)
  {
    chain: "ethereum",
    address: "0x3ee18B2214AFF97000D974cf647E7C347E8fa585",
    name: "Wormhole Bridge",
    type: "lock_mint",
    destinationChains: ["polygon", "ethereum"]
  },
  {
    chain: "polygon",
    address: "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE",
    name: "Wormhole Bridge",
    type: "lock_mint",
    destinationChains: ["ethereum"]
  },
  // Synapse Bridge
  {
    chain: "ethereum",
    address: "0x6C888886b7Eb0F5bE25D3B5D7F6eD28E4830b2c5",
    name: "Synapse Bridge",
    type: "lock_mint",
    destinationChains: ["polygon", "ethereum"]
  },
  // Celer cBridge
  {
    chain: "ethereum",
    address: "0xC564EE9f21Ed8A2d8E7e89C79630004681a5c62e",
    name: "Celer cBridge",
    type: "lock_mint",
    destinationChains: ["polygon", "ethereum"]
  },
  // Hop Protocol
  {
    chain: "ethereum",
    address: "0x8637E39a8Ce9177683477C4D12E56603fBe4a8E3",
    name: "Hop Protocol",
    type: "lock_mint",
    destinationChains: ["polygon", "ethereum"]
  },
  // Stargate
  {
    chain: "ethereum",
    address: "0x8731d54E9D02c286767d56ac03e8037C07e01e98",
    name: "Stargate Bridge",
    type: "lock_mint",
    destinationChains: ["polygon", "ethereum"]
  },
  // Multichain (Anyswap) on other chains
  {
    chain: "polygon",
    address: "0x3a8b8c6E5E86531238D8208bD2F410549D5dC37a",
    name: "Multichain (Anyswap)",
    type: "lock_mint",
    destinationChains: ["ethereum", "tron"]
  },
];

/**
 * Check if a transaction interacts with a known bridge contract.
 */
export function detectBridgeInteraction(
  tx: NormalizedTransaction,
  _address: string
): { bridge: BridgeContract; direction: "deposit" | "withdrawal" | "interaction" } | null {
  const txTransfers = tx.transfers ?? [];
  
  // Check if any transfer involves a known bridge contract
  for (const transfer of txTransfers) {
    const fromAddr = transfer.from?.toLowerCase();
    const toAddr = transfer.to?.toLowerCase();
    const contractAddr = transfer.contract?.toLowerCase();
    
    // Check from address (deposit to bridge)
    if (fromAddr) {
      const bridge = KNOWN_BRIDGES.find(b => b.address.toLowerCase() === fromAddr && b.chain === tx.chain);
      if (bridge) {
        return { bridge, direction: "deposit" };
      }
    }
    
    // Check to address (withdrawal from bridge)
    if (toAddr) {
      const bridge = KNOWN_BRIDGES.find(b => b.address.toLowerCase() === toAddr && b.chain === tx.chain);
      if (bridge) {
        return { bridge, direction: "withdrawal" };
      }
    }
    
    // Check contract interaction
    if (contractAddr) {
      const bridge = KNOWN_BRIDGES.find(b => b.address.toLowerCase() === contractAddr && b.chain === tx.chain);
      if (bridge) {
        return { bridge, direction: "interaction" };
      }
    }
  }
  
  // Also check direct from/to addresses in the transaction
  const fromTx = tx.from?.toLowerCase();
  const toTx = tx.to?.toLowerCase();
  
  if (fromTx) {
    const bridge = KNOWN_BRIDGES.find(b => b.address.toLowerCase() === fromTx && b.chain === tx.chain);
    if (bridge) return { bridge, direction: "deposit" };
  }
  
  if (toTx) {
    const bridge = KNOWN_BRIDGES.find(b => b.address.toLowerCase() === toTx && b.chain === tx.chain);
    if (bridge) return { bridge, direction: "withdrawal" };
  }
  
  return null;
}

/**
 * Get bridge contracts for a specific chain
 */
export function getBridgesForChain(chain: Chain): BridgeContract[] {
  return KNOWN_BRIDGES.filter(b => b.chain === chain);
}

/**
 * Check if an address is a known bridge contract
 */
export function isKnownBridge(chain: Chain, address: string): BridgeContract | null {
  const normalized = address.toLowerCase();
  return KNOWN_BRIDGES.find(b => b.chain === chain && b.address.toLowerCase() === normalized) ?? null;
}

/**
 * Known bridge names for reference
 */
export const BRIDGE_NAMES = [
  "Polygon Bridge (PoS)",
  "Polygon Bridge (Plasma)",
  "Arbitrum Bridge",
  "Optimism Bridge",
  "Base Bridge",
  "Multichain (Anyswap)",
  "Wormhole Bridge",
  "Synapse Bridge",
  "Celer cBridge",
  "Hop Protocol",
  "Stargate Bridge",
  "WBTC Bridge",
  "RenBTC Bridge"
];