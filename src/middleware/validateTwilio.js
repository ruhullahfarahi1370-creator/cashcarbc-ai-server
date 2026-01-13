// src/middleware/validateTwilio.js
import twilio from "twilio";

/**
 * Render/Express note:
 * - Set BASE_URL to your public Render URL, e.g. https://cashcarbc.onrender.com
 * - Twilio will call https://cashcarbc.onrender.com/twilio/voice and /twilio/collect
 *
 * IMPORTANT:
 * - Twilio signature validation must use the EXACT full URL Twilio called.
 * - And it must validate against the *raw* form body (x-www-form-urlencoded),
 *   not a mutated/parsed version.
 */

/** Remove trailing slashes so BASE_URL + req.originalUrl doesn't double-slash */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

/**
 * Extract raw POST body for Twilio signature validation.
 * - We prefer req.rawBody (set by bodyParser verify hook).
 * - Fallback to req.body (works sometimes, but raw is safer).
 */
function getParamsForValidation(req) {
  // If you used bodyParser.urlencoded({ verify: (req,res,buf)=> req.rawBody = buf.toString() })
  if (req.rawBody && typeof req.rawBody === "string") {
    // Twilio expects params as a key/value object, not a string.
    // Convert querystring-like body into an object.
    return Object.fromEntries(new URLSearchParams(req.rawBody));
  }

  // Fallback: parsed body (less reliable if middleware changed it)
  return req.body || {};
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

    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      console.error("[TWILIO_VALIDATE] TWILIO_AUTH_TOKEN env var is missing");
      return res.status(500).send("Server misconfigured");
    }

    // Must match EXACT URL Twilio is calling (the one in Twilio Console)
    // Example: https://cashcarbc.onrender.com/twilio/voice
    const fullUrl = base + req.originalUrl;

    const params = getParamsForValidation(req);

    const ok = twilio.validateRequest(authToken, signature, fullUrl, params);

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
