import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { YieldVault } from "../target/types/yield_vault";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { assert, expect } from "chai";
import axios from "axios";

describe("yield_vault production verification suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.YieldVault as Program<YieldVault>;

  let baseTokenMint: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  let vaultAuthPda: anchor.web3.PublicKey;
  let shareMintPda: anchor.web3.PublicKey;
  let tokenReserveAta: anchor.web3.PublicKey;

  let userA = anchor.web3.Keypair.generate();
  let userAUserTokenAccount: anchor.web3.PublicKey;

  const VAULT_SEED = Buffer.from("vault");
  const VAULT_AUTH_SEED = Buffer.from("vault_auth");
  const SHARE_MINT_SEED = Buffer.from("share_mint");

  before(async () => {
    // Fund User
    const sig = await provider.connection.requestAirdrop(
      userA.publicKey,
      5 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Create Base Token Mint
    baseTokenMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.wallet.publicKey,
      null,
      9
    );

    // Derive Program Addresses
    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [VAULT_SEED, baseTokenMint.toBuffer()],
      program.programId
    );
    [vaultAuthPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [VAULT_AUTH_SEED],
      program.programId
    );
    [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [SHARE_MINT_SEED, baseTokenMint.toBuffer()],
      program.programId
    );

    // Mint base tokens to User A
    const userA_ATA = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as any).payer,
      baseTokenMint,
      userA.publicKey
    );
    userAUserTokenAccount = userA_ATA.address;

    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      baseTokenMint,
      userAUserTokenAccount,
      provider.wallet.publicKey,
      10 * 1_000_000_000
    );
  });

  it("Initializes the Yield Vault successfully with deterministic PDAs", async () => {
    const tx = await program.methods
      .initializeVault()
      .accounts({
        admin: provider.wallet.publicKey,
        tokenMint: baseTokenMint,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.admin.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(vaultAccount.totalDeposited.toNumber()).to.equal(0);
    expect(vaultAccount.isPaused).to.be.false;
  });

  it("Executes a 1-click deposit and correctly calculates 1:1 first-deposit shares", async () => {
    const depositAmount = new anchor.BN(1 * 1_000_000_000);

    const userShareAta = anchor.utils.token.associatedAddress({
      mint: shareMintPda,
      owner: userA.publicKey,
    });

    await program.methods
      .deposit(depositAmount)
      .accounts({
        user: userA.publicKey,
        vault: vaultPda,
        shareMint: shareMintPda,
        userTokenAccount: userAUserTokenAccount,
        userShareAccount: userShareAta,
      })
      .signers([userA])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.totalDeposited.toNumber()).to.equal(1_000_000_000);

    const shareAccountInfo = await getAccount(provider.connection, userShareAta);
    expect(Number(shareAccountInfo.amount)).to.equal(1_000_000_000);
  });

  it("Rejects zero-lamport deposit attempts strictly", async () => {
    const userShareAta = anchor.utils.token.associatedAddress({
      mint: shareMintPda,
      owner: userA.publicKey,
    });

    try {
      await program.methods
        .deposit(new anchor.BN(0))
        .accounts({
          user: userA.publicKey,
          vault: vaultPda,
          shareMint: shareMintPda,
          userTokenAccount: userAUserTokenAccount,
          userShareAccount: userShareAta,
        })
        .signers([userA])
        .rpc();
      assert.fail("Should have thrown ZeroDepositAmount error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ZeroDepositAmount");
    }
  });

  it("Enforces emergency pause constraints", async () => {
    // Admin toggles pause
    await program.methods
      .setPaused(true)
      .accounts({
        admin: provider.wallet.publicKey,
        vault: vaultPda,
      })
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vaultPda);
    expect(vaultAccount.isPaused).to.be.true;

    // User deposit must fail while paused
    const userShareAta = anchor.utils.token.associatedAddress({
      mint: shareMintPda,
      owner: userA.publicKey,
    });

    try {
      await program.methods
        .deposit(new anchor.BN(100_000))
        .accounts({
          user: userA.publicKey,
          vault: vaultPda,
          shareMint: shareMintPda,
          userTokenAccount: userAUserTokenAccount,
          userShareAccount: userShareAta,
        })
        .signers([userA])
        .rpc();
      assert.fail("Should have failed due to paused state");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("VaultPaused");
    }

    // Unpause for clean state
    await program.methods
      .setPaused(false)
      .accounts({
        admin: provider.wallet.publicKey,
        vault: vaultPda,
      })
      .rpc();
  });
});