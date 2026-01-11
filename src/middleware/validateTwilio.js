import twilio from "twilio";

export function validateTwilioRequest(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!authToken) {
    console.error("TWILIO_AUTH_TOKEN missing");
    return res.status(500).send("Server misconfiguration");
  }

  const signature = req.headers["x-twilio-signature"];
  const url = `${process.env.BASE_URL}${req.originalUrl}`;

  const ok = twilio.validateRequest(authToken, signature, url, req.body);

  if (!ok) {
    console.warn("Invalid Twilio signature");
    return res.status(403).send("Forbidden");
  }

  next();
}
