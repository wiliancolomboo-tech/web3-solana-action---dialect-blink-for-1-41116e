import request from "supertest";
import app from "../src/server";
import { Keypair } from "@solana/web3.js";

describe("Dialect Action Blink API Specification Validation", () => {
  const dummyWallet = Keypair.generate().publicKey.toBase58();

  it("GET /api/actions/vault-deposit conforms to Dialect spec metadata", async () => {
    const res = await request(app).get("/api/actions/vault-deposit");

    expect(res.status).toBe(200);
    expect(res.headers["x-action-version"]).toBe("2.1.3");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.body).toHaveProperty("icon");
    expect(res.body).toHaveProperty("title");
    expect(res.body).toHaveProperty("description");
    expect(res.body).toHaveProperty("links.actions");
    expect(Array.isArray(res.body.links.actions)).toBe(true);
  });

  it("POST /api/actions/vault-deposit builds valid base64 serialized transaction", async () => {
    const res = await request(app)
      .post("/api/actions/vault-deposit?amount=25")
      .send({ account: dummyWallet });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("transaction");
    expect(typeof res.body.transaction).toBe("string");
    expect(res.body.transaction.length).toBeGreaterThan(50);
  });

  it("GET /actions.json returns mapping rules for unfurling", async () => {
    const res = await request(app).get("/actions.json");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rules");
    expect(res.body.rules[0].pathPattern).toBe("/vault-deposit/**");
  });
});