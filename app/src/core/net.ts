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
  template: "",
  crypt: "",
  /** µT per summoning; must match the crypt's on-chain dose (set_dose). */
  dose: 2n * 1_000_000n,
};
