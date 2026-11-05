import express, { Request, Response } from "express";
import cors from "cors";
import {
  Connection,
  PublicKey,
  Transaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// Strict Action CORS Headers
const actionCorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "Content-Type": "application/json",
  "X-Action-Version": "2.1.3",
  "X-Blockchain-Ids": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

app.use((req, res, next) => {
  res.set(actionCorsHeaders);
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
});

// Environment Configuration
const PORT = process.env.PORT || 3000;
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || clusterApiUrl("devnet");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "Vau1tXN8YwK2qM4aM5rXgP6dE7T9uV1wY2z3A4b5C6d"
);
const UNDERLYING_MINT = new PublicKey(
  process.env.UNDERLYING_MINT || "So11111111111111111111111111111111111111112" // Wrapped SOL default
);
const VAULT_SEED = new BN(1001);

const connection = new Connection(RPC_ENDPOINT, "confirmed");

// Helpers for PDA Derivations
function getVaultPda(seed: BN): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), seed.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );
}

function getTokenVaultPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), vault.toBuffer()],
    PROGRAM_ID
  );
}

function getShareMintPda(vault: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("share_mint"), vault.toBuffer()],
    PROGRAM_ID
  );
}

// Enterprise Webhook Dispatcher
async function dispatchEnterpriseNotification(
  wallet: string,
  amount: number,
  type: "deposit_intent" | "finalized"
) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await axios.post(DISCORD_WEBHOOK_URL, {
      embeds: [
        {
          title: `🛡️ Blink Vault Event: ${type.toUpperCase()}`,
          color: type === "deposit_intent" ? 0x00f0ff : 0x00ff66,
          fields: [
            { name: "Depositor Account", value: `\`${wallet}\``, inline: false },
            { name: "Amount (Units)", value: `${amount}`, inline: true },
            { name: "Timestamp", value: new Date().toISOString(), inline: true },
          ],
          footer: { text: "Solana Action Dialect Sentinel" },
        },
      ],
    });
  } catch (error) {
    console.error("Failed to notify enterprise webhook:", error);
  }
}

/**
 * 1. GET /api/actions/vault-deposit
 * Returns Action definition & UI controls compliant with Dialect Blink specification.
 */
app.get("/api/actions/vault-deposit", async (req: Request, res: Response) => {
  const payload = {
    type: "action",
    icon: "https://arweave.net/k9ZkM5c8Zvh8G9e1s4_VaultBanner_1024x512.png",
    title: "1-Click Solana Automated Yield Vault",
    description:
      "Deposit SOL or SPL tokens directly into the yield aggregator in one click. Proportional vault LP tokens are automatically minted back to your wallet.",
    label: "Deposit",
    links: {
      actions: [
        {
          label: "0.1 SOL",
          href: "/api/actions/vault-deposit?amount=0.1",
        },
        {
          label: "0.5 SOL",
          href: "/api/actions/vault-deposit?amount=0.5",
        },
        {
          label: "1.0 SOL",
          href: "/api/actions/vault-deposit?amount=1.0",
        },
        {
          label: "Deposit Custom",
          href: "/api/actions/vault-deposit?amount={amount}",
          parameters: [
            {
              name: "amount",
              label: "Enter custom deposit amount",
              required: true,
            },
          ],
        },
      ],
    },
  };

  return res.status(200).json(payload);
});

/**
 * 2. POST /api/actions/vault-deposit
 * Builds, serializes, and returns the deposit transaction.
 */
app.post("/api/actions/vault-deposit", async (req: Request, res: Response) => {
  try {
    const { account } = req.body;
    const amountStr = req.query.amount as string;

    if (!account) {
      return res.status(400).json({ error: "Missing required 'account' field in body." });
    }

    const userPubkey = new PublicKey(account);
    const amountNum = parseFloat(amountStr);

    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ error: "Invalid deposit 'amount' query parameter." });
    }

    // Convert decimal to raw atomic integer (9 decimals standard for SOL/WSOL)
    const rawAmount = new BN(Math.floor(amountNum * 1e9));

    // PDA Resolutions
    const [vault] = getVaultPda(VAULT_SEED);
    const [tokenVault] = getTokenVaultPda(vault);
    const [shareMint] = getShareMintPda(vault);

    // Associated Token Accounts for user
    const userTokenAta = getAssociatedTokenAddressSync(
      UNDERLYING_MINT,
      userPubkey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const userShareAta = getAssociatedTokenAddressSync(
      shareMint,
      userPubkey,
      false,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const tx = new Transaction();

    // Idempotent creation of user's share ATA if it does not yet exist
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        userPubkey,
        userShareAta,
        userPubkey,
        shareMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    // Minimal discriminator for `deposit` (Anchor sighash: sha256("global:deposit")[..8])
    // Pre-computed: [242, 35, 198, 137, 82, 225, 242, 182]
    const depositInstructionDiscriminator = Buffer.from([
      0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6,
    ]);

    const amountBuffer = rawAmount.toArrayLike(Buffer, "le", 8);
    const minSharesBuffer = new BN(1).toArrayLike(Buffer, "le", 8); // Slippage tolerance minimum
    const instructionData = Buffer.concat([
      depositInstructionDiscriminator,
      amountBuffer,
      minSharesBuffer,
    ]);

    const depositInstruction = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: userPubkey, isSigner: true, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: tokenVault, isSigner: false, isWritable: true },
        { pubkey: shareMint, isSigner: false, isWritable: true },
        { pubkey: userTokenAta, isSigner: false, isWritable: true },
        { pubkey: userShareAta, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: instructionData,
    };

    tx.add(depositInstruction);

    // Fetch latest blockhash with finalized commitment
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPubkey;

    // Serialize wire transaction without signatures
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });

    const base64Tx = serializedTx.toString("base64");

    // Asynchronously alert internal enterprise monitoring
    dispatchEnterpriseNotification(account, amountNum, "deposit_intent");

    return res.status(200).json({
      transaction: base64Tx,
      message: `Deposit ${amountNum} into Solana Vault ready to sign.`,
    });
  } catch (err: any) {
    console.error("Action handler exception:", err);
    return res.status(500).json({
      error: err.message || "Internal server error while formulating Blink action.",
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: Date.now() });
});

app.listen(PORT, () => {
  console.log(`[Blink Core] Gateway running on http://localhost:${PORT}`);
  console.log(`[Blink Core] Action URL: http://localhost:${PORT}/api/actions/vault-deposit`);
});