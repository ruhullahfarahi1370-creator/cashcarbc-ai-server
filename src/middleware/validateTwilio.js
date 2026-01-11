// src/middleware/validateTwilio.js
import twilio from "twilio";

function normalizeBaseUrl(baseUrl) {
  // Remove trailing slash if present
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function validateTwilioRequest(req, res, next) {
  try {
    const signature = req.headers["x-twilio-signature"];

    if (!signature) {
      console.warn("[TWILIO_VALIDATE] Missing X-Twilio-Signature header");
      return res.status(403).send("Forbidden");
    }

    const base = normalizeBaseUrl(process.env.BASE_URL);
    if (!base) {
      console.error("[TWILIO_VALIDATE] BASE_URL env var is missing");
      return res.status(500).send("Server misconfigured");
    }

    if (!process.env.TWILIO_AUTH_TOKEN) {
      console.error("[TWILIO_VALIDATE] TWILIO_AUTH_TOKEN env var is missing");
      return res.status(500).send("Server misconfigured");
    }

    // Must match the EXACT URL Twilio is calling (the one you set in Twilio Console)
    const fullUrl = base + req.originalUrl;

    const ok = twilio.validateRequest(
      process.env.TWILIO_AUTH_TOKEN,
      signature,
      fullUrl,
      req.body // Twilio sends params as x-www-form-urlencoded
    );

    if (!ok) {
      console.warn("[TWILIO_VALIDATE] Invalid signature", {
        fullUrl,
        originalUrl: req.originalUrl,
      });
      return res.status(403).send("Forbidden");
    }

    return next();
  } catch (err) {
    console.error("[TWILIO_VALIDATE] Error validating request:", err);
    return res.status(500).send("Validation error");
  }
}
