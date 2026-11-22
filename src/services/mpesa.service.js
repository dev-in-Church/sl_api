// Safaricom Daraja: B2C payments (paying suppliers).
//
// Everything is configured through environment variables, see mpesa.env.example.
// Payouts stay OFF until MPESA_ENABLED=true.
import crypto from "node:crypto";
import fs from "node:fs";

export class MpesaError extends Error {
  // definite = true  -> we know the money was NOT sent
  // definite = false -> unclear (network error / timeout): do not retry blindly
  constructor(message, { definite = true } = {}) {
    super(message);
    this.name = "MpesaError";
    this.definite = definite;
  }
}

const env = (name, fallback) => process.env[name] ?? fallback;
function required(name) {
  const value = process.env[name];
  if (!value) throw new MpesaError(`M-Pesa is not configured: ${name} is missing.`);
  return value;
}

export const payoutsEnabled = () => process.env.MPESA_ENABLED === "true";
const baseUrl = () =>
  env("MPESA_ENV", "sandbox") === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";

async function mpesaFetch(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

let cachedToken = null;
async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const key = required("MPESA_CONSUMER_KEY");
  const secret = required("MPESA_CONSUMER_SECRET");
  let response;
  try {
    response = await mpesaFetch(
      `${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
        },
      },
    );
  } catch {
    // Nothing has been sent yet, so this is a definite failure
    throw new MpesaError("Could not reach M-Pesa to authenticate. Try again.");
  }
  if (!response.ok)
    throw new MpesaError(
      "M-Pesa rejected the consumer key/secret. Check the Daraja credentials.",
    );
  const json = await response.json();
  cachedToken = {
    value: json.access_token,
    expires: Date.now() + Math.max(60, Number(json.expires_in) - 60) * 1000,
  };
  return cachedToken.value;
}

// The initiator password, encrypted with Safaricom's public certificate.
// Either set MPESA_SECURITY_CREDENTIAL directly, or MPESA_INITIATOR_PASSWORD + MPESA_CERT_PATH.
function securityCredential() {
  if (process.env.MPESA_SECURITY_CREDENTIAL)
    return process.env.MPESA_SECURITY_CREDENTIAL;
  const password = required("MPESA_INITIATOR_PASSWORD");
  const certPath = required("MPESA_CERT_PATH");
  let cert;
  try {
    cert = fs.readFileSync(certPath);
  } catch {
    throw new MpesaError(`M-Pesa certificate not found at ${certPath}.`);
  }
  // Accept the certificate as PEM or as the raw DER .cer Safaricom provides
  const text = cert.toString("utf8");
  const pem = text.includes("BEGIN CERTIFICATE")
    ? text
    : `-----BEGIN CERTIFICATE-----\n${cert.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----\n`;
  return crypto
    .publicEncrypt(
      { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(password),
    )
    .toString("base64");
}

// Sends KSh `amount` (whole shillings) to `phone` (2547XXXXXXXX).
// Resolves when M-Pesa ACCEPTED the request. The final result arrives later
// on the Result URL (routes/mpesa.routes.js).
export async function sendB2C({ requestId, amount, phone, remarks, occasion }) {
  const path = env("MPESA_B2C_PATH", "/mpesa/b2c/v3/paymentrequest");
  const callbackBase = required("MPESA_CALLBACK_BASE_URL").replace(/\/$/, "");
  const secret = required("MPESA_CALLBACK_SECRET");
  const token = await accessToken();

  const body = {
    // The v3 API lets us choose the conversation id, which makes callbacks easy to match
    ...(path.includes("/v3/") ? { OriginatorConversationID: requestId } : {}),
    InitiatorName: required("MPESA_INITIATOR_NAME"),
    SecurityCredential: securityCredential(),
    CommandID: env("MPESA_B2C_COMMAND", "BusinessPayment"),
    Amount: amount,
    PartyA: required("MPESA_SHORTCODE"),
    PartyB: phone,
    Remarks: String(remarks || "Milk payment").slice(0, 100),
    QueueTimeOutURL: `${callbackBase}/api/mpesa/b2c/timeout/${secret}`,
    ResultURL: `${callbackBase}/api/mpesa/b2c/result/${secret}`,
    Occassion: String(occasion || "").slice(0, 100), // (sic) Daraja's spelling
  };

  let response;
  try {
    response = await mpesaFetch(`${baseUrl()}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new MpesaError(
      "Could not confirm whether M-Pesa received the payment (network error or timeout). Check the M-Pesa portal before trying again.",
      { definite: false },
    );
  }

  let json = {};
  try {
    json = await response.json();
  } catch {
    /* no JSON body */
  }
  if (!response.ok) {
    const message =
      json.errorMessage ||
      json.ResponseDescription ||
      `M-Pesa rejected the request (HTTP ${response.status}).`;
    // 4xx = rejected before processing. 5xx = unclear.
    throw new MpesaError(message, { definite: response.status < 500 });
  }
  if (String(json.ResponseCode) !== "0")
    throw new MpesaError(json.ResponseDescription || "M-Pesa rejected the request.");
  return {
    conversationId: json.ConversationID ?? null,
    originatorConversationId: json.OriginatorConversationID ?? null,
    description: json.ResponseDescription ?? null,
  };
}
