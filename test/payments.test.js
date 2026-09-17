const test = require("node:test");
const assert = require("node:assert/strict");
const { app, resetMocks } = require("../src/app");
const http = require("http");

let server;
let baseUrl;

test.before(async () => {
  resetMocks();
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function request(body, headers = {}) {
  const response = await fetch(`${baseUrl}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return {
    status: response.status,
    headers: response.headers,
    body: await response.json()
  };
}

test("400 for missing amount", async () => {
  const r = await request(
    { transaction_ref: "tx_missing_amount" },
    { Authorization: "Bearer valid-token" }
  );
  assert.equal(r.status, 400);
  assert.equal(r.body.error.param, "amount");
  assert.equal(r.body.error.code, "required");
});

test("401 for missing/invalid auth", async () => {
  const r = await request({ amount: 100, transaction_ref: "tx_auth" });
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, "auth_failed");
});

test("403 for viewer attempting a write", async () => {
  const r = await request(
    { amount: 100, transaction_ref: "tx_viewer" },
    { Authorization: "Bearer viewer-token" }
  );
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "permission_denied");
});

test("422 when amount exceeds 100000", async () => {
  const r = await request(
    { amount: 100001, transaction_ref: "tx_limit" },
    { Authorization: "Bearer valid-token" }
  );
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, "limit_exceeded");
  assert.equal(r.body.error.max, 100000);
});

test("409 for duplicate transaction_ref", async () => {
  const headers = { Authorization: "Bearer valid-token" };

  const first = await request(
    { amount: 500, transaction_ref: "tx_duplicate" },
    headers
  );
  const second = await request(
    { amount: 500, transaction_ref: "tx_duplicate" },
    headers
  );

  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "duplicate");
});

test("same idempotency key + same amount returns original response", async () => {
  const headers = {
    Authorization: "Bearer valid-token",
    "Idempotency-Key": "idem-001"
  };

  const first = await request(
    { amount: 750, transaction_ref: "tx_idem_1" },
    headers
  );
  const retry = await request(
    { amount: 750, transaction_ref: "tx_idem_1_retry" },
    headers
  );

  assert.equal(first.status, 201);
  assert.equal(retry.status, 201);
  assert.deepEqual(retry.body, first.body);
});

test("same idempotency key + different amount returns 400", async () => {
  const headers = {
    Authorization: "Bearer valid-token",
    "Idempotency-Key": "idem-002"
  };

  const first = await request(
    { amount: 800, transaction_ref: "tx_idem_2" },
    headers
  );
  const second = await request(
    { amount: 900, transaction_ref: "tx_idem_3" },
    headers
  );

  assert.equal(first.status, 201);
  assert.equal(second.status, 400);
  assert.equal(second.body.error.code, "idempotency_key_reused");
});

test("v1 accepts amount_inr as a fallback", async () => {
  const r = await request(
    { amount_inr: 1200, transaction_ref: "tx_legacy" },
    { Authorization: "Bearer valid-token" }
  );

  assert.equal(r.status, 201);
  assert.equal(r.body.amount, 1200);
});

test("amount takes priority when both amount and amount_inr are sent", async () => {
  const r = await request(
    { amount: 1500, amount_inr: 9999, transaction_ref: "tx_both" },
    { Authorization: "Bearer valid-token" }
  );

  assert.equal(r.status, 201);
  assert.equal(r.body.amount, 1500);
});

test("rate limit returns 429 and Retry-After after 50 requests", async () => {
  resetMocks();

  const headers = { Authorization: "Bearer admin-token" };

  for (let i = 0; i < 50; i++) {
    const r = await request(
      { amount: 10, transaction_ref: `tx_rate_${i}` },
      headers
    );
    assert.notEqual(r.status, 429);
  }

  const blocked = await request(
    { amount: 10, transaction_ref: "tx_rate_blocked" },
    headers
  );

  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, "rate_limit_exceeded");
  assert.ok(blocked.headers.get("retry-after"));
});