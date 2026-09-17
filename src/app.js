const express = require("express");

const app = express();
app.use(express.json());

// Mock database layer.
const db = {
  transactions: new Map(),
  nextId: 1,

  findTransaction(transactionRef) {
    return this.transactions.get(transactionRef);
  },

  createPayment({ transactionRef, amount, userId }) {
    const existing = this.transactions.get(transactionRef);
    if (existing) return existing;

    const payment = {
      id: `pay_${String(this.nextId++).padStart(4, "0")}`,
      transaction_ref: transactionRef,
      amount,
      user_id: userId,
      status: "succeeded"
    };

    this.transactions.set(transactionRef, payment);
    return payment;
  }
};

// Mock cache layer for idempotency and rate limiting.
const cache = {
  idempotency: new Map(),
  rate: new Map()
};

function resetMocks() {
  db.transactions.clear();
  db.nextId = 1;
  cache.idempotency.clear();
  cache.rate.clear();
}

// Mock authentication.
// Accept "Bearer valid-token" as an operator and "Bearer viewer-token" as a viewer.
function authMiddleware(req, res, next) {
  const header = req.get("Authorization");

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        code: "auth_failed",
        message: "Authentication token is missing or invalid."
      }
    });
  }

  const token = header.slice("Bearer ".length).trim();

  if (token === "valid-token") {
    req.user = { id: "user_001", role: "operator" };
  } else if (token === "viewer-token") {
    req.user = { id: "user_viewer", role: "viewer" };
  } else if (token === "admin-token") {
    req.user = { id: "user_admin", role: "admin" };
  } else {
    return res.status(401).json({
      error: {
        code: "auth_failed",
        message: "Authentication token is missing or invalid."
      }
    });
  }

  next();
}

function requireWriteRole(req, res, next) {
  if (!["operator", "admin"].includes(req.user.role)) {
    return res.status(403).json({
      error: {
        code: "permission_denied",
        message: "The authenticated user does not have permission to create payments."
      }
    });
  }

  next();
}

// 50 requests per minute per authenticated client.
function rateLimiter(limit = 50, windowSeconds = 60) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.user.id;
    const existing = cache.rate.get(key);

    if (!existing || now >= existing.resetAt) {
      cache.rate.set(key, {
        count: 1,
        resetAt: now + windowSeconds * 1000
      });
      return next();
    }

    existing.count += 1;

    if (existing.count > limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((existing.resetAt - now) / 1000)
      );

      res.setHeader("Retry-After", String(retryAfter));

      return res.status(429).json({
        error: {
          code: "rate_limit_exceeded",
          message: "Too many requests. Please retry after the quota resets.",
          limit: `${limit} per minute`,
          retry_after_seconds: retryAfter
        }
      });
    }

    next();
  };
}

// v1 compatibility normalization.
// v2: remove amount_inr fallback
function normaliseFields(req, res, next) {
  if (req.body.amount === undefined && req.body.amount_inr !== undefined) {
    req.body.amount = req.body.amount_inr;
  }
  next();
}

function validateRequest(req, res, next) {
  if (req.body.amount === undefined || req.body.amount === null) {
    return res.status(400).json({
      error: {
        param: "amount",
        code: "required",
        message: "The amount field is required."
      }
    });
  }

  if (
    typeof req.body.amount !== "number" ||
    !Number.isFinite(req.body.amount) ||
    req.body.amount <= 0
  ) {
    return res.status(400).json({
      error: {
        param: "amount",
        code: "invalid",
        message: "Amount must be a positive number."
      }
    });
  }

  if (req.body.amount > 100000) {
    return res.status(422).json({
      error: {
        param: "amount",
        code: "limit_exceeded",
        max: 100000
      }
    });
  }

  if (!req.body.transaction_ref) {
    return res.status(400).json({
      error: {
        param: "transaction_ref",
        code: "required",
        message: "The transaction_ref field is required."
      }
    });
  }

  next();
}

app.post(
  "/v1/payments",
  authMiddleware,
  rateLimiter(50, 60),
  requireWriteRole,
  normaliseFields,
  validateRequest,
  (req, res) => {
    const { amount, transaction_ref } = req.body;
    const idempotencyKey = req.get("Idempotency-Key");

    // Retry safety: same key + same amount returns the original response.
    if (idempotencyKey) {
      const cached = cache.idempotency.get(idempotencyKey);

      if (cached) {
        if (cached.amount !== amount) {
          return res.status(400).json({
            error: {
              code: "idempotency_key_reused",
              message: "Idempotency-Key sent before with different amount."
            }
          });
        }

        return res.status(201).json(cached.response);
      }
    }

    const existing = db.findTransaction(transaction_ref);
    if (existing) {
      return res.status(409).json({
        error: {
          code: "duplicate",
          existing_id: existing.id
        }
      });
    }

    // Mock charge + persistence operation.
    const payment = db.createPayment({
      transactionRef: transaction_ref,
      amount,
      userId: req.user.id
    });

    const response = {
      id: payment.id,
      transaction_ref: payment.transaction_ref,
      amount: payment.amount,
      status: payment.status
    };

    if (idempotencyKey) {
      cache.idempotency.set(idempotencyKey, {
        amount,
        response
      });
    }

    return res.status(201).json(response);
  }
);

module.exports = { app, resetMocks, db, cache };