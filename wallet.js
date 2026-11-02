// wallet.js — Load wallet from private key (supports base58 or JSON array)

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import "dotenv/config";

export function loadWallet() {
  const raw = process.env.PRIVATE_KEY;
  if (!raw) throw new Error("PRIVATE_KEY not set in environment");

  let keypair;
  try {
    // Try JSON array format: [1,2,3,...]
    const arr = JSON.parse(raw);
    keypair = Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    // Try base58 string
    try {
      const bytes = bs58.decode(raw);
      keypair = Keypair.fromSecretKey(bytes);
    } catch {
      throw new Error("PRIVATE_KEY is neither valid JSON array nor base58");
    }
  }

  return keypair;
}

export function publicKeyStr(keypair) {
  return keypair.publicKey.toBase58();
}
