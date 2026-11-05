import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaVault } from "../target/types/solana_vault";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { PublicKey, Keypair } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("solana_vault_tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaVault as Program<SolanaVault>;

  let underlyingMint: PublicKey;
  let vaultSeed: anchor.BN;
  let vaultPda: PublicKey;
  let tokenVaultPda: PublicKey;
  let shareMintPda: PublicKey;

  let user = Keypair.generate();
  let userTokenAccount: PublicKey;
  let userShareAccount: PublicKey;

  const INITIAL_MINT_AMOUNT = 5_000_000_000; // 5 tokens (9 decimals)
  const DEPOSIT_CAP = new anchor.BN(10_000_000_000);

  before(async () => {
    // Airdrop SOL to payer & test user
    const airdropSig = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // Create mock underlying token
    underlyingMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      9
    );

    vaultSeed = new anchor.BN(Date.now());

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), vaultSeed.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [tokenVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("token_vault"), vaultPda.toBuffer()],
      program.programId
    );

    [shareMintPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("share_mint"), vaultPda.toBuffer()],
      program.programId
    );

    // Setup user token accounts
    const userAtaObj = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      underlyingMint,
      user.publicKey
    );
    userTokenAccount = userAtaObj.address;

    const userShareObj = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      shareMintPda,
      user.publicKey,
      true
    );
    userShareAccount = userShareObj.address;

    // Mint underlying tokens to user
    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      underlyingMint,
      userTokenAccount,
      provider.wallet.publicKey,
      INITIAL_MINT_AMOUNT
    );
  });

  it("1. Successfully initializes the vault with deterministic PDAs", async () => {
    await program.methods
      .initializeVault(vaultSeed, DEPOSIT_CAP)
      .accounts({
        authority: provider.wallet.publicKey,
        vault: vaultPda,
        underlyingMint: underlyingMint,
        tokenVault: tokenVaultPda,
        shareMint: shareMintPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    assert.strictEqual(
      vaultAccount.authority.toBase58(),
      provider.wallet.publicKey.toBase58()
    );
    assert.strictEqual(vaultAccount.depositCap.toNumber(), DEPOSIT_CAP.toNumber());
    assert.strictEqual(vaultAccount.totalDeposited.toNumber(), 0);
  });

  it("2. Genesis deposit mints 1:1 LP shares", async () => {
    const depositAmount = new anchor.BN(1_000_000_000); // 1 token
    const minSharesExpected = new anchor.BN(1_000_000_000);

    await program.methods
      .deposit(depositAmount, minSharesExpected)
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        tokenVault: tokenVaultPda,
        shareMint: shareMintPda,
        userToken: userTokenAccount,
        userShareAccount: userShareAccount,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const userShareBalance = await getAccount(provider.connection, userShareAccount);
    const tokenVaultBalance = await getAccount(provider.connection, tokenVaultPda);

    assert.strictEqual(Number(userShareBalance.amount), 1_000_000_000);
    assert.strictEqual(Number(tokenVaultBalance.amount), 1_000_000_000);
  });

  it("3. Rejects zero deposit with custom error", async () => {
    try {
      await program.methods
        .deposit(new anchor.BN(0), new anchor.BN(0))
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          tokenVault: tokenVaultPda,
          shareMint: shareMintPda,
          userToken: userTokenAccount,
          userShareAccount: userShareAccount,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Should have thrown ZeroDepositAmount error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroDepositAmount");
    }
  });

  it("4. Enforces slippage protection correctly", async () => {
    const depositAmount = new anchor.BN(500_000_000);
    // Demanding unrealistic shares will trigger SlippageExceeded
    const excessiveMinShares = new anchor.BN(9_000_000_000);

    try {
      await program.methods
        .deposit(depositAmount, excessiveMinShares)
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          tokenVault: tokenVaultPda,
          shareMint: shareMintPda,
          userToken: userTokenAccount,
          userShareAccount: userShareAccount,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
      assert.fail("Expected transaction to fail on slippage check");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
  });
});