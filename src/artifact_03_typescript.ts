import {
  ActionGetResponse,
  ActionPostRequest,
  ActionPostResponse,
  ACTIONS_CORS_HEADERS,
  createActionHeaders,
} from "@solana/actions";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import { Program, AnchorProvider, BN, Idl } from "@coral-xyz/anchor";
import idl from "./idl/vault_deposit.json";

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
const PROGRAM_ID = new PublicKey("V1tB1inkDepositVault111111111111111111111111111");
const UNDERLYING_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

const VAULT_ID = new BN(1);
const [vaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_state"), VAULT_ID.toArrayLike(Buffer, "le", 8)],
  PROGRAM_ID
);
const [vaultAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_authority"), VAULT_ID.toArrayLike(Buffer, "le", 8)],
  PROGRAM_ID
);
const [shareMint] = PublicKey.findProgramAddressSync(
  [Buffer.from("share_mint"), VAULT_ID.toArrayLike(Buffer, "le", 8)],
  PROGRAM_ID
);

export const headers = createActionHeaders({
  headers: {
    ...ACTIONS_CORS_HEADERS,
    "Access-Control-Allow-Origin": "*",
  },
});

export async function GET(req: Request): Promise<Response> {
  const payload: ActionGetResponse = {
    type: "action",
    icon: "https://arweave.net/7sJ3k_VaultBlinkCoverImage_HighYield_1080x1080.png",
    title: "1-Click Liquid USDC Yield Staking",
    description:
      "Deposit USDC directly into the auto-compounding Alpha Vault to earn 8.4% APY. Instantly mints vUSDC shares back to your wallet.",
    label: "Deposit & Stake",
    links: {
      actions: [
        {
          label: "Deposit 25 USDC",
          href: "/api/actions/vault-deposit?amount=25",
        },
        {
          label: "Deposit 100 USDC",
          href: "/api/actions/vault-deposit?amount=100",
        },
        {
          label: "Deposit Custom Amount",
          href: "/api/actions/vault-deposit?amount={amount}",
          parameters: [
            {
              name: "amount",
              label: "Enter USDC Amount to Deposit",
              required: true,
            },
          ],
        },
      ],
    },
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers,
  });
}

export async function OPTIONS(req: Request): Promise<Response> {
  return new Response(null, { headers });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const amountParam = url.searchParams.get("amount");
    if (!amountParam || isNaN(Number(amountParam)) || Number(amountParam) <= 0) {
      return new Response(
        JSON.stringify({ error: "Invalid deposit amount specified." }),
        { status: 400, headers }
      );
    }

    const body: ActionPostRequest = await req.json();
    let userPubkey: PublicKey;
    try {
      userPubkey = new PublicKey(body.account);
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid account public key." }),
        { status: 400, headers }
      );
    }

    const depositAmountUnits = new BN(Math.floor(Number(amountParam) * 1_000_000)); // 6 decimals for USDC
    const minSharesOut = depositAmountUnits.muln(995).divn(1000); // 0.5% max slippage allowed

    // Compute ATAs
    const userUnderlyingAta = getAssociatedTokenAddressSync(UNDERLYING_MINT, userPubkey);
    const userShareAta = getAssociatedTokenAddressSync(shareMint, userPubkey);
    const vaultTokenAccount = getAssociatedTokenAddressSync(UNDERLYING_MINT, vaultAuthority, true);

    // Setup dummy provider to instantiate Anchor client interface
    const dummyWallet = {
      publicKey: userPubkey,
      signTransaction: async () => { throw new Error("Unimplemented"); },
      signAllTransactions: async () => { throw new Error("Unimplemented"); },
    };
    const provider = new AnchorProvider(connection, dummyWallet as any, {
      commitment: "confirmed",
    });
    const program = new Program(idl as Idl, PROGRAM_ID, provider);

    // Instruction Pipeline
    const instructions = [
      // 1. Set priority fees & CU ceiling
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),

      // 2. Ensure user share ATA exists
      createAssociatedTokenAccountIdempotentInstruction(
        userPubkey,
        userShareAta,
        userPubkey,
        shareMint
      ),

      // 3. Main program deposit instruction
      await program.methods
        .depositAndStake(depositAmountUnits, minSharesOut)
        .accounts({
          user: userPubkey,
          vault: vaultPda,
          vaultAuthority,
          underlyingMint: UNDERLYING_MINT,
          shareMint,
          vaultTokenAccount,
          userTokenAccount: userUnderlyingAta,
          userShareAccount: userShareAta,
          tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        })
        .instruction(),
    ];

    // Build Versioned Transaction
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const messageV0 = new TransactionMessage({
      payerKey: userPubkey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);
    const serializedTx = Buffer.from(versionedTx.serialize()).toString("base64");

    const responsePayload: ActionPostResponse = {
      transaction: serializedTx,
      message: `Deposit ${amountParam} USDC into Alpha Vault and received vUSDC`,
    };

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers,
    });
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message || "Failed to craft deposit transaction" }),
      { status: 500, headers }
    );
  }
}