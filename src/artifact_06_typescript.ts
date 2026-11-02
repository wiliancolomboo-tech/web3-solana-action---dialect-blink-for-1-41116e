import { expect } from "chai";
import request from "supertest";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import app from "../src/index";

describe("OmniVault Blink End-to-End Suite", () => {
  const dummyUser = Keypair.generate();

  describe("1. Action Specification & OpenAPI Compliance", () => {
    it("returns valid actions.json manifest for URL routing", async () => {
      const res = await request(app)
        .get("/actions.json")
        .expect("Content-Type", /json/)
        .expect(200);

      expect(res.body).to.have.property("rules");
      expect(res.body.rules).to.be.an("array");
      expect(res.body.rules[0].apiPath).to.equal("/api/actions/vault-deposit");
    });

    it("serves valid GET metadata conforming to Dialect Blink Spec v2.1.3", async () => {
      const res = await request(app)
        .get("/api/actions/vault-deposit")
        .expect("Content-Type", /json/)
        .expect(200);

      expect(res.headers).to.have.property("access-control-allow-origin", "*");
      expect(res.body).to.include.keys("type", "icon", "title", "description", "label", "links");
      expect(res.body.type).to.equal("action");
      expect(res.body.links.actions).to.be.an("array").with.lengthOf(4);
      
      const customParam = res.body.links.actions.find(
        (a: any) => a.parameters && a.parameters.length > 0
      );
      expect(customParam).to.exist;
      expect(customParam.parameters[0].name).to.equal("amount");
    });
  });

  describe("2. Transaction Building & Safety Checks", () => {
    it("fails with 400 when missing signer account in POST body", async () => {
      const res = await request(app)
        .post("/api/actions/vault-deposit?amount=0.5")
        .send({})
        .expect(400);

      expect(res.body.error).to.contain("Missing 'account' field");
    });

    it("fails with 400 when invalid deposit amount is provided", async () => {
      const res = await request(app)
        .post("/api/actions/vault-deposit?amount=-5")
        .send({ account: dummyUser.publicKey.toBase58() })
        .expect(400);

      expect(res.body.error).to.contain("Invalid 'amount'");
    });

    it("successfully returns Base64 serialized transaction envelope on valid input", async () => {
      const res = await request(app)
        .post("/api/actions/vault-deposit?amount=0.25")
        .send({ account: dummyUser.publicKey.toBase58() })
        .expect(200);

      expect(res.body).to.have.property("type", "transaction");
      expect(res.body).to.have.property("transaction");
      expect(res.body).to.have.property("message");
      expect(res.body.message).to.contain("0.25 SOL prepared successfully");

      // Verify Base64 payload decoding integrity
      const txBuffer = Buffer.from(res.body.transaction, "base64");
      expect(txBuffer.length).to.be.greaterThan(100);
    });
  });

  describe("3. Telemetry & Liveness Monitoring", () => {
    it("exposes system health and block height via /healthz", async () => {
      const res = await request(app).get("/healthz").expect(200);
      expect(res.body).to.have.property("status", "UP");
      expect(res.body).to.have.property("current_slot");
      expect(res.body).to.have.property("program_id");
    });
  });
});