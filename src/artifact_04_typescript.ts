import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  clusterApiUrl,
  ComputeBudgetProgram
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TokenAccountNotFoundError
} from "@solana/spl-token";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import axios from "axios";

// Environment validation
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const VAULT_PROGRAM_ID = new PublicKey(
  process.env.VAULT_PROGRAM_ID || "V1tB1inkDepositVault1111111111111111111111111"
);
const UNDERLYING_MINT = new PublicKey(
  process.env.UNDERLYING_MINT || "So11111111111111111111111111111111111111112" // wSOL default
);

// Minimal Anchor IDL definition for client-side Instruction compilation
const IDL: Idl = {
  version: "0.1.0",
  name: "solana_vault_blink",
  instructions: [
    {
      name: "deposit",
      accounts: [
        { name: "user", isMut: true, isSigner: true },
        { name: "vault", isMut: true, isSigner: false },
        { name: "underlyingMint", isMut: false, isSigner: false },
        { name: "vaultTokenAccount", isMut: true, isSigner: false },
        { name: "shareMint", isMut: true, isSigner: false },
        { name: "userTokenAccount", isMut: true, isSigner: false },
        { name: "userShareAccount", isMut: true, isSigner: false },
        { name: "tokenProgram", isMut: false, isSigner: false }
      ],
      args: [
        { name: "amount", type: "u64" },
        { name: "minSharesOut", type: "u64" }
      ]
    }
  ]
};

const connection = new Connection(RPC_URL, "confirmed");
const app: FastifyInstance = Fastify({ logger: true });

// Register CORS headers compliant with Dialect and Solana Action standards
app.register(cors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Content-Encoding",
    "Accept-Encoding",
    "x-action-version",
    "x-blockchain-ids"
  ],
  exposedHeaders: ["x-action-version", "x-blockchain-ids"]
});

// Seed Constants
const VAULT_SEED = Buffer.from("vault_state");
const VAULT_TOKEN_SEED = Buffer.from("vault_token_account");
const SHARE_MINT_SEED = Buffer.from("vault_share_mint");

function getVaultPDAs(mint: PublicKey) {
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [VAULT_SEED, mint.toBuffer()],
    VAULT_PROGRAM_ID
  );
  const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
    [VAULT_TOKEN_SEED, vaultPda.toBuffer()],
    VAULT_PROGRAM_ID
  );
  const [shareMint] = PublicKey.findProgramAddressSync(
    [SHARE_MINT_SEED, vaultPda.toBuffer()],
    VAULT_PROGRAM_ID
  );
  return { vaultPda, vaultTokenAccount, shareMint };
}

// ---------------------------------------------------------------------
// Solana Actions Specification Handlers
// ---------------------------------------------------------------------

// 1. Root Actions JSON rewrite map
app.get("/actions.json", async (req: FastifyRequest, reply: FastifyReply) => {
  return reply.status(200).send({
    rules: [
      {
        pathPattern: "/vault-deposit",
        apiPath: "/api/actions/vault-deposit"
      },
      {
        pathPattern: "/api/actions/**",
        apiPath: "/api/actions/**"
      }
    ]
  });
});

// 2. Solana Action GET: Returns interactive metadata & execution options
app.get("/api/actions/vault-deposit", async (req: FastifyRequest, reply: FastifyReply) => {
  const baseHref = "/api/actions/vault-deposit";

  const actionMetadata = {
    type: "action",
    icon: "https://raw.githubusercontent.com/solana-developers/brand-assets/main/assets/solanaLogoMark.png",
    title: "1-Click Solana High-Yield Yield Vault",
    description:
      "Deposit SOL/wSOL directly into the automated yield-bearing vault. Instant liquidity, receipt shares, and automated rebalancing.",
    label: "Deposit",
    links: {
      actions: [
        {
          label: "Deposit 0.1 SOL",
          href: `${baseHref}?amount=0.1`
        },
        {
          label: "Deposit 0.5 SOL",
          href: `${baseHref}?amount=0.5`
        },
        {
          label: "Deposit 1.0 SOL",
          href: `${baseHref}?amount=1.0`
        },
        {
          label: "Custom Deposit",
          href: `${baseHref}?amount={amount}`,
          parameters: [
            {
              name: "amount",
              label: "Enter deposit amount in SOL",
              required: true
            }
          ]
        }
      ]
    }
  };

  reply.header("x-action-version", "2.1.3");
  reply.header("x-blockchain-ids", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  return reply.status(200).send(actionMetadata);
});

// 3. Solana Action POST: Builds and returns the signed/serialized wire transaction
interface PostDepositBody {
  account: string;
}

interface PostDepositQuery {
  amount?: string;
}

app.post("/api/actions/vault-deposit", async (req: FastifyRequest, reply: FastifyReply) => {
  try {
    const body = req.body as PostDepositBody;
    const query = req.query as PostDepositQuery;

    if (!body || !body.account) {
      return reply.status(400).send({ error: "Missing required parameter: 'account'" });
    }

    const userPubkey = new PublicKey(body.account);
    const amountVal = parseFloat(query.amount || "0.1");

    if (isNaN(amountVal) || amountVal <= 0) {
      return reply.status(400).send({ error: "Invalid deposit amount specified" });
    }

    const lamports = Math.floor(amountVal * 1e9);
    const { vaultPda, vaultTokenAccount, shareMint } = getVaultPDAs(UNDERLYING_MINT);

    const userTokenAccount = getAssociatedTokenAddressSync(UNDERLYING_MINT, userPubkey);
    const userShareAccount = getAssociatedTokenAddressSync(shareMint, userPubkey);

    const tx = new Transaction();

    // Set priority fee compute budget instructions
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })
    );

    // Verify if user's receipt share account exists; if not, prepend initialization instruction
    try {
      await getAccount(connection, userShareAccount);
    } catch (e: any) {
      if (e instanceof TokenAccountNotFoundError || e.name === "TokenAccountNotFoundError") {
        tx.add(
          createAssociatedTokenAccountInstruction(
            userPubkey,
            userShareAccount,
            userPubkey,
            shareMint
          )
        );
      }
    }

    // Build dummy anchor provider for instruction synthesis
    const dummyWallet = {
      publicKey: userPubkey,
      signTransaction: async (t: any) => t,
      signAllTransactions: async (t: any) => t
    };
    const provider = new AnchorProvider(connection, dummyWallet as any, {
      commitment: "confirmed"
    });
    const program = new Program(IDL, VAULT_PROGRAM_ID, provider);

    const minSharesOut = new BN(1); // 1 lamport slippage guard
    const depositIx = await program.methods
      .deposit(new BN(lamports), minSharesOut)
      .accounts({
        user: userPubkey,
        vault: vaultPda,
        underlyingMint: UNDERLYING_MINT,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        userTokenAccount: userTokenAccount,
        userShareAccount: userShareAccount,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
      })
      .instruction();

    tx.add(depositIx);

    // Get blockhash and fee payer
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPubkey;

    // Serialize transaction without signatures for Dialect Blink wallet injection
    const serializedTx = tx.serialize({
      requireAllSignatures: false,
      verifySignatures: false
    });
    const base64Tx = serializedTx.toString("base64");

    // Asynchronously dispatch webhook telemetry
    dispatchEnterpriseAudit(userPubkey.toBase58(), amountVal, blockhash).catch((err) =>
      console.error("Telemetry error:", err.message)
    );

    const responsePayload = {
      type: "transaction",
      transaction: base64Tx,
      message: `Successfully generated atomic 1-Click deposit for ${amountVal} SOL into the High-Yield Vault!`
    };

    reply.header("x-action-version", "2.1.3");
    reply.header("x-blockchain-ids", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    return reply.status(200).send(responsePayload);
  } catch (error: any) {
    req.log.error(error);
    return reply.status(500).send({
      error: `Failed to construct transaction: ${error.message || "Internal server error"}`
    });
  }
});

// ---------------------------------------------------------------------
// Enterprise Webhook & Notification Engine
// ---------------------------------------------------------------------
async function dispatchEnterpriseAudit(user: string, amount: number, blockhash: string) {
  const timestamp = new Date().toISOString();

  // 1. Dispatch Discord Alert
  if (DISCORD_WEBHOOK_URL) {
    try {
      await axios.post(DISCORD_WEBHOOK_URL, {
        embeds: [
          {
            title: "Solana Action Blink Deposit Generated",
            color: 0x14f195, // Solana Green
            fields: [
              { name: "Depositor", value: `\`${user}\``, inline: false },
              { name: "Amount", value: `${amount} SOL`, inline: true },
              { name: "Blockhash", value: `\`${blockhash.slice(0, 12)}...\``, inline: true },
              { name: "Timestamp", value: timestamp, inline: false }
            ],
            footer: { text: "Solana Action Audit Daemon" }
          }
        ]
      });
    } catch (e: any) {
      console.error("Discord audit error:", e.message);
    }
  }

  // 2. Dispatch Enterprise Email via Resend
  if (RESEND_API_KEY) {
    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "vault-audits@solana-blink-enterprise.com",
          to: "secops-defi@enterprise.corp",
          subject: `[SOLANA BLINK ACTION] Deposit Intent: ${amount} SOL`,
          html: `
            <h2>Solana Blink Deposit Intent Recorded</h2>
            <p><strong>User Address:</strong> ${user}</p>
            <p><strong>Amount:</strong> ${amount} SOL</p>
            <p><strong>Blockhash:</strong> ${blockhash}</p>
            <p><strong>Timestamp:</strong> ${timestamp}</p>
          `
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
    } catch (e: any) {
      console.error("Resend API error:", e.message);
    }
  }
}

// ---------------------------------------------------------------------
// Server Lifecycle
// ---------------------------------------------------------------------
const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    console.log(`Blink Action Server active on port ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();