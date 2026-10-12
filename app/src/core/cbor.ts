// Instruction-argument literals for the Crypt template's methods.
import { bytesLiteral, intLiteral, stringLiteral, fromHexStr } from "@tari-project/ootle";
export const strLit = (s: string) => stringLiteral(s);
export const hashLit = (hex: string) => bytesLiteral(fromHexStr(hex));
export const u64Lit = (n: number | bigint) => intLiteral(BigInt(n));
