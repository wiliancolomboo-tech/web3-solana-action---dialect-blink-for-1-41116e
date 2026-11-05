import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import request from "supertest";

describe("Solana Blink Vault Core - Comprehensive QA Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  // Load Program via Anchor workspace
  const program = anchor.workspace.VaultCore as Program<any>;

  let underlyingMint: PublicKey;
  let vaultPda: PublicKey;
  let vaultTokenAccountPda: PublicKey;
  let shareMintPda: PublicKey;
  let vaultBump: number;

  const admin = Keypair.generate();
  const alice = Keypair.generate();
  let aliceTokenAccount: PublicKey;
  let aliceShareAccount: PublicKey;

  before(async () => {
    // Airdrop SOL to test actors
    const sig1 = await provider.connection.requestAirdrop(admin.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const sig2 = await provider.connection.requestAirdrop(alice.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig1);
    await provider.connection.confirmTransaction(sig2);

    // Create Test USDC Mint
    underlyingMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Derive PDAs
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), underlyingMint.toBuffer()],
      program.programId
    );

    [vaultTokenAccountPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), vaultPda.toBuffer()],
      program.programId
    );

    [shareMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), vaultPda.toBuffer()],
      program.programId
    );

    // Setup Alice Token Accounts
    aliceTokenAccount = await createAccount(
      provider.connection,
      alice,
      underlyingMint,
      alice.publicKey
    );

    aliceShareAccount = await createAccount(
      provider.connection,
      alice,
      shareMintPda,
      alice.publicKey
    );

    // Mint test USDC to Alice
    await mintTo(
      provider.connection,
      admin,
      underlyingMint,
      aliceTokenAccount,
      admin,
      1_000_000_000 // 1,000 USDC
    );
  });

  it("TC-01: Successfully initializes the Vault with deterministic PDAs", async () => {
    const [, depositBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_tokens"), vaultPda.toBuffer()],
      program.programId
    );
    const [, shareBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), vaultPda.toBuffer()],
      program.programId
    );

    await program.methods
      .initializeVault(depositBump, shareBump)
      .accounts({
        authority: admin.publicKey,
        underlyingMint: underlyingMint,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.authority.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(vaultAccount.totalDeposited.toNumber()).to.equal(0);
    expect(vaultAccount.paused).to.be.false;
  });

  it("TC-02: Enforces Anti-Inflation Minimum Deposit on First Inflow", async () => {
    // Attempting to deposit 500 units (threshold is 1,000)
    try {
      await program.methods
        .deposit(new anchor.BN(500))
        .accounts({
          userAuthority: alice.publicKey,
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccountPda,
          shareMint: shareMintPda,
          userTokenAccount: aliceTokenAccount,
          userShareAccount: aliceShareAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();
      assert.fail("Should have thrown DepositTooSmall error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("DepositTooSmall");
    }
  });

  it("TC-03: Executes Standard Deposit and Mints 1:1 Shares for Alice", async () => {
    const depositAmount = new anchor.BN(50_000_000); // 50 USDC

    await program.methods
      .deposit(depositAmount)
      .accounts({
        userAuthority: alice.publicKey,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        userTokenAccount: aliceTokenAccount,
        userShareAccount: aliceShareAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    const aliceShareBal = await getAccount(provider.connection, aliceShareAccount);
    expect(Number(aliceShareBal.amount)).to.equal(50_000_000);

    const vaultTokenBal = await getAccount(provider.connection, vaultTokenAccountPda);
    expect(Number(vaultTokenBal.amount)).to.equal(50_000_000);
  });

  it("TC-04: Emergency Controls - Blocks Deposits when Paused", async () => {
    // Admin pauses the vault
    await program.methods
      .setPaused(true)
      .accounts({
        vault: vaultPda,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    try {
      await program.methods
        .deposit(new anchor.BN(10_000_000))
        .accounts({
          userAuthority: alice.publicKey,
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccountPda,
          shareMint: shareMintPda,
          userTokenAccount: aliceTokenAccount,
          userShareAccount: aliceShareAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();
      assert.fail("Should have failed due to paused state");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultPaused");
    }

    // Unpause for clean test cleanup
    await program.methods
      .setPaused(false)
      .accounts({
        vault: vaultPda,
        authority: admin.publicKey,
      })
      .signers([admin])
      .rpc();
  });
});