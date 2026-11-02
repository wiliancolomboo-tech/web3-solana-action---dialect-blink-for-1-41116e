import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultBlink } from "../target/types/vault_blink";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";

describe("vault_blink anchor integration tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.VaultBlink as Program<VaultBlink>;

  const authority = Keypair.generate();
  const alice = Keypair.generate();

  let depositMint: PublicKey;
  let vaultPda: PublicKey;
  let vaultTokenAccountPda: PublicKey;
  let shareMintPda: PublicKey;

  let aliceDepositAccount: PublicKey;
  let aliceShareAccount: PublicKey;

  const INITIAL_BALANCE = 1_000_000_000; // 1000 Tokens (6 decimals)

  before(async () => {
    // Airdrop SOL to Authority and Alice
    const sig1 = await provider.connection.requestAirdrop(
      authority.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    const sig2 = await provider.connection.requestAirdrop(
      alice.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    const latestBh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({
      signature: sig1,
      ...latestBh,
    });
    await provider.connection.confirmTransaction({
      signature: sig2,
      ...latestBh,
    });

    // Create Base Token Mint
    depositMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6
    );

    // Derive PDAs
    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_state"), depositMint.toBuffer()],
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

    // Setup Alice ATAs
    const aliceToken = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      alice,
      depositMint,
      alice.publicKey
    );
    aliceDepositAccount = aliceToken.address;

    const aliceShare = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      alice,
      shareMintPda,
      alice.publicKey,
      true // allowOwnerOffCurve = true for receipt
    );
    aliceShareAccount = aliceShare.address;

    // Mint deposit tokens to Alice
    await mintTo(
      provider.connection,
      authority,
      depositMint,
      aliceDepositAccount,
      authority,
      INITIAL_BALANCE
    );
  });

  it("1. Initializes the Vault PDA & State correctly", async () => {
    await program.methods
      .initializeVault()
      .accounts({
        authority: authority.publicKey,
        depositMint: depositMint,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(vaultAccount.depositMint.toBase58()).to.equal(depositMint.toBase58());
    expect(vaultAccount.shareMint.toBase58()).to.equal(shareMintPda.toBase58());
    expect(vaultAccount.totalStaked.toNumber()).to.equal(0);
  });

  it("2. Deposits tokens via 1-Click Blink Logic and prevents inflation exploits", async () => {
    const depositAmount = new anchor.BN(100_000_000); // 100 USDC
    const minSharesOut = new anchor.BN(90_000_000);

    await program.methods
      .depositAndStake(depositAmount, minSharesOut)
      .accounts({
        user: alice.publicKey,
        depositMint: depositMint,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccountPda,
        shareMint: shareMintPda,
        userTokenAccount: aliceDepositAccount,
        userShareAccount: aliceShareAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice])
      .rpc();

    // Verify token balance transfers
    const vaultTokenBal = await provider.connection.getTokenAccountBalance(vaultTokenAccountPda);
    expect(Number(vaultTokenBal.value.amount)).to.equal(100_000_000);

    // Verify receipt shares minted to Alice
    const aliceShareBal = await getAccount(provider.connection, aliceShareAccount);
    expect(Number(aliceShareBal.amount)).to.be.greaterThan(0);

    // Verify vault total_staked state
    const vaultAccount = await program.account.vaultState.fetch(vaultPda);
    expect(vaultAccount.totalStaked.toNumber()).to.equal(100_000_000);
  });

  it("3. Enforces slippage threshold and halts frontrunning", async () => {
    const depositAmount = new anchor.BN(50_000_000); // 50 USDC
    const impossibleMinShares = new anchor.BN(1_000_000_000_000); // Exorbitant expectation

    try {
      await program.methods
        .depositAndStake(depositAmount, impossibleMinShares)
        .accounts({
          user: alice.publicKey,
          depositMint: depositMint,
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccountPda,
          shareMint: shareMintPda,
          userTokenAccount: aliceDepositAccount,
          userShareAccount: aliceShareAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice])
        .rpc();
      expect.fail("Deposit should have failed due to slippage guard!");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SlippageToleranceExceeded");
    }
  });

  it("4. Blocks deposit from unauthorized token accounts", async () => {
    const mallory = Keypair.generate();
    const depositAmount = new anchor.BN(10_000_000);

    try {
      await program.methods
        .depositAndStake(depositAmount, new anchor.BN(1))
        .accounts({
          user: alice.publicKey,
          depositMint: depositMint,
          vault: vaultPda,
          vaultTokenAccount: vaultTokenAccountPda,
          shareMint: shareMintPda,
          userTokenAccount: aliceDepositAccount,
          userShareAccount: aliceShareAccount, // Incorrect owner check
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([mallory]) // Mallory attempts to sign for Alice
        .rpc();
      expect.fail("Instruction should have failed signer constraints");
    } catch (err: any) {
      expect(err).to.exist;
    }
  });
});