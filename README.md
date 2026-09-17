# ZPay Endpoint Hardening

Implementation of `POST /v1/payments` for the Kalvium **Endpoint Reliability: Errors, Retries, and Versioning** assignment.

## Reliability decisions

1. **Error semantics**
   - `400` missing/invalid request fields
   - `401` missing/invalid authentication
   - `403` insufficient role
   - `409` duplicate `transaction_ref`
   - `422` amount over ₹1,00,000
   - `429` rate limit exceeded + `Retry-After`

2. **Idempotency**
   - Accepts `Idempotency-Key`
   - Same key + same amount returns the original `201` response
   - Same key + different amount returns `400`
   - Payment is not created twice

3. **Rate limiting**
   - 50 requests per minute per authenticated user
   - Uses an in-memory mock cache
   - Returns `429` and `Retry-After`

4. **Versioning**
   - v1 accepts both `amount` and legacy `amount_inr`
   - `amount` takes priority when both exist
   - Legacy fallback is marked:
     `// v2: remove amount_inr fallback`

## Local setup

Requirements: Node.js 18+.

```bash
npm install
npm test
npm start
```

The API runs at `http://localhost:3000`.

## Example requests

### Successful payment

```bash
curl -i -X POST http://localhost:3000/v1/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer valid-token" \
  -H "Idempotency-Key: order-123" \
  -d '{"amount":5000,"transaction_ref":"txn-001"}'
```

### Legacy v1 field

```bash
curl -i -X POST http://localhost:3000/v1/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer valid-token" \
  -d '{"amount_inr":5000,"transaction_ref":"txn-002"}'
```

### Viewer role

```bash
curl -i -X POST http://localhost:3000/v1/payments \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer viewer-token" \
  -d '{"amount":5000,"transaction_ref":"txn-003"}'
```

## Mock assumptions

- `valid-token` represents an authenticated operator.
- `viewer-token` represents an authenticated viewer.
- `admin-token` represents an authenticated admin.
- Database and cache are in-memory mocks; no external services are required.
- The charge itself is represented by creating a payment record in the mock database.
- Rate-limit state is per authenticated user ID.
- This is intentionally a local assignment implementation, not production payment infrastructure.

## Required Git workflow

Create the assignment branch:

```bash
git checkout main
git checkout -b hardened-contract
```

Commit using exactly:

```text
feat: harden POST /v1/payments with error semantics, idempotency, rate limiting, versioning
```

Then push the branch and open a PR from `hardened-contract` into `main`.

## PR description

```md
## Endpoint Hardening: POST /v1/payments

Implements four reliability decisions:
1. ✅ Error Responses (400, 401, 403, 409, 422, 429)
2. ✅ Idempotency (Idempotency-Key header)
3. ✅ Rate Limiting (50 req/min, 429 + Retry-After)
4. ✅ Versioning (support amount_inr in v1, mark for v2 removal)

## Endpoint Hardening

Implemented POST /v1/payments with error handling, idempotency,
rate limiting, and backward-compatible API versioning.
```
