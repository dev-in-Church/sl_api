// Public callbacks called by Safaricom. Mount WITHOUT requireAuth:
//   app.use("/api/mpesa", mpesaRoutes);
// The long random MPESA_CALLBACK_SECRET in the URL is what protects these endpoints.
import { Router } from "express";
import crypto from "node:crypto";
import { pool } from "../config/db.js";
import { sendPaymentReceipt } from "../services/payment-notifications.service.js";

const router = Router();

function validSecret(given) {
  const expected = process.env.MPESA_CALLBACK_SECRET || "";
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return expected.length >= 16 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const accepted = { ResultCode: 0, ResultDesc: "Accepted" };

// Final outcome of a payout
router.post("/b2c/result/:secret", async (req, res) => {
  if (!validSecret(req.params.secret))
    return res.status(403).json({ error: "Forbidden" });
  try {
    const result = req.body?.Result;
    if (result) {
      const params = {};
      for (const item of [].concat(result.ResultParameters?.ResultParameter ?? []))
        params[item.Key] = item.Value;
      const ok = Number(result.ResultCode) === 0;
      const updated = await pool.query(
        `UPDATE supplier_payments
            SET status = $1,
                result_code = $2,
                result_desc = $3,
                mpesa_receipt = $4,
                completed_at = NOW(),
                conversation_id = COALESCE(conversation_id, $5),
                raw_result = $6
          WHERE status IN ('pending', 'timeout')
            AND (request_id = $7 OR originator_conversation_id = $7 OR conversation_id = $5)
        RETURNING id`,
        [
          ok ? "completed" : "failed",
          Number(result.ResultCode),
          result.ResultDesc ?? null,
          ok ? (params.TransactionReceipt ?? result.TransactionID ?? null) : null,
          result.ConversationID ?? null,
          JSON.stringify(req.body),
          result.OriginatorConversationID ?? null,
        ],
      );
      // Email the receipt without making Safaricom wait for it (never throws)
      if (ok && updated.rows[0]) sendPaymentReceipt(updated.rows[0].id);
    }
  } catch (error) {
    console.error("M-Pesa result callback failed:", error);
  }
  res.json(accepted);
});

// M-Pesa gave up waiting in its queue: the outcome is unknown until checked
router.post("/b2c/timeout/:secret", async (req, res) => {
  if (!validSecret(req.params.secret))
    return res.status(403).json({ error: "Forbidden" });
  try {
    const result = req.body?.Result ?? req.body;
    const id = result?.OriginatorConversationID ?? null;
    const conversation = result?.ConversationID ?? null;
    await pool.query(
      `UPDATE supplier_payments
          SET status = 'timeout',
              result_desc = 'M-Pesa timed out. Check the M-Pesa portal, then mark this payment as paid or failed.'
        WHERE status = 'pending'
          AND (request_id = $1 OR originator_conversation_id = $1 OR conversation_id = $2)`,
      [id, conversation],
    );
  } catch (error) {
    console.error("M-Pesa timeout callback failed:", error);
  }
  res.json(accepted);
});

export default router;
