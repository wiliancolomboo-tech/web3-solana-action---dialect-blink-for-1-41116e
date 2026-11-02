import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaVaultBlink } from "../target/types/solana_vault_blink";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import { expect } from "chai";

describe("Solana Vault Blink Integration Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolanaVaultBlink as Program<SolanaVaultBlink>;

  const authority = Keypair.generate();
  const user = Keypair.generate();

  let underlyingMint: PublicKey;
  let userTokenAccount: PublicKey;
  let userShareAccount: PublicKey;

  let vaultPda: PublicKey;
  let vaultTokenAccount: PublicKey;
  let shareMint: PublicKey;

  before(async () => {
    // 1. Airdrop SOL to test actors
    const airdropAuth = await provider.connection.requestAirdrop(
      authority.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropAuth);

    const airdropUser = await provider.connection.requestAirdrop(
      user.publicKey,
      10 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropUser);

    // 2. Create Underlying SPL Token Mint
    underlyingMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      9
    );

    // 3. Derive Program PDAs
    const [derivedVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_state"), underlyingMint.toBuffer()],
      program.programId
    );
    vaultPda = derivedVault;

    const [derivedVaultToken] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_token_account"), vaultPda.toBuffer()],
      program.programId
    );
    vaultTokenAccount = derivedVaultToken;

    const [derivedShareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_share_mint"), vaultPda.toBuffer()],
      program.programId
    );
    shareMint = derivedShareMint;

    // 4. Create User Token Accounts & Mint Starting Balance (100 tokens)
    userTokenAccount = await createAccount(
      provider.connection,
      user,
      underlyingMint,
      user.publicKey
    );

    userShareAccount = await createAccount(
      provider.connection,
      user,
      shareMint,
      user.publicKey
    );

    await mintTo(
      provider.connection,
      authority,
      underlyingMint,
      userTokenAccount,
      authority,
      100 * 10 ** 9
    );
  });

  it("1. Successfully executes InitializeVault instruction", async () => {
    const feeBps = 200; // 2%

    await program.methods
      .initializeVault(feeBps)
      .accounts({
        authority: authority.publicKey,
        underlyingMint: underlyingMint,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY
      })
      .signers([authority])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.authority.toBase58()).to.equal(authority.publicKey.toBase58());
    expect(vaultAccount.underlyingMint.toBase58()).to.equal(underlyingMint.toBase58());
    expect(vaultAccount.managementFeeBps).to.equal(feeBps);
    expect(vaultAccount.totalDeposited.toNumber()).to.equal(0);
    expect(vaultAccount.totalSharesMinted.toNumber()).to.equal(0);
  });

  it("2. Successfully processes standard 1-Click deposit into vault", async () => {
    const depositAmount = new anchor.BN(10 * 10 ** 9); // 10 Tokens
    const minSharesOut = new anchor.BN(10 * 10 ** 9); // Initial 1:1 ratio expectation

    await program.methods
      .deposit(depositAmount, minSharesOut)
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        underlyingMint: underlyingMint,
        vaultTokenAccount: vaultTokenAccount,
        shareMint: shareMint,
        userTokenAccount: userTokenAccount,
        userShareAccount: userShareAccount,
        tokenProgram: TOKEN_PROGRAM_ID
      })
      .signers([user])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.totalDeposited.toString()).to.equal(depositAmount.toString());
    expect(vaultAccount.totalSharesMinted.toString()).to.equal(depositAmount.toString());

    // Verify token account states
    const vaultBal = await getAccount(provider.connection, vaultTokenAccount);
    expect(vaultBal.amount.toString()).to.equal(depositAmount.toString());

    const userShares = await getAccount(provider.connection, userShareAccount);
    expect(userShares.amount.toString()).to.equal(depositAmount.toString());
  });

  it("3. Enforces strict zero-deposit rejection", async () => {
    let hasFailed = false;
    try {
      await program.methods
        .deposit(new anchor.BN(0), new anchor.BN(0))
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          underlyingMint: underlyingMint,
          vaultTokenAccount: vaultTokenAccount,
          shareMint: shareMint,
          userTokenAccount: userTokenAccount,
          userShareAccount: userShareAccount,
          tokenProgram: TOKEN_PROGRAM_ID
        })
        .signers([user])
        .rpc();
    } catch (err: any) {
      hasFailed = true;
      expect(err.error.errorCode.code).to.equal("ZeroDepositAmount");
    }
    expect(hasFailed).to.be.true;
  });

  it("4. Enforces slippage tolerance limits on minimum shares received", async () => {
    const depositAmount = new anchor.BN(5 * 10 ** 9);
    const impossibleMinShares = new anchor.BN(100 * 10 ** 9); // Demanding 100 shares for 5 tokens

    let hasFailed = false;
    try {
      await program.methods
        .deposit(depositAmount, impossibleMinShares)
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          underlyingMint: underlyingMint,
          vaultTokenAccount: vaultTokenAccount,
          shareMint: shareMint,
          userTokenAccount: userTokenAccount,
          userShareAccount: userShareAccount,
          tokenProgram: TOKEN_PROGRAM_ID
        })
        .signers([user])
        .rpc();
    } catch (err: any) {
      hasFailed = true;
      expect(err.error.errorCode.code).to.equal("SlippageExceeded");
    }
    expect(hasFailed).to.be.true;
  });
});