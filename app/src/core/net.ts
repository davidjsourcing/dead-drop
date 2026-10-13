// Network constants for Dead Drop. Everything here is public.
import { Network } from "@tari-project/ootle";

export const NETWORK = Network.Esmeralda;
export const NETWORK_BYTE = 0x26; // esmeralda
export const INDEXER_URL = "https://ootle-indexer-a.tari.com";
/** The native stealth tTARI resource. */
export const TARI = "resource_0101010101010101010101010101010101010101010101010101010101010101";
/** µTari per tTARI. */
export const MICRO = 1_000_000n;

/** Filled in after the Crypt template is published and a crypt component is opened (see DEPLOYMENT.md). */
export const DEPLOYMENT = {
  template: "57d02c26b94121ce11a8ad9b93e9ac19e8acea190b5d12f16a6e420e41c25bd7",
  crypt: "component_2ef70ea3131676f968c035d6162f4d1dfd5894d1dfae4fd700d3e2a2f669d479",
  /** The cauldron vault inside the crypt (declared as a transaction input whenever the cauldron is touched). */
  cauldron: "vault_2e8a1bd9ca585a54ec6d0c44e700c106152644016ddea9012a994e0245ad9967",
  /** µT per summoning; must match the crypt's on-chain dose (set_dose). */
  dose: 2n * 1_000_000n,
};

/** The Halloween hunt starts at this grave in the crypt's graveyard (each secret names the next grave). */
export const HUNT_START_GRAVE = 4;
/** The hunt in order (each secret names the next grave). */
export const HUNT_GRAVES = [4, 3, 2];
/** The Midnight Grave: answer printed on the stone, raise refused by the validators until after its AfterEpoch (seeded Oct 13 by scripts/midnight.ts). */
export const MIDNIGHT_GRAVE = 8;
