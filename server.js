// server.js
import express from "express";
import bodyParser from "body-parser";
import { PORT } from "./src/config/constants.js";
import { validateTwilioRequest } from "./src/middleware/validateTwilio.js";
import { twilioVoice, twilioCollect } from "./src/controllers/twilioController.js";

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path}`);
  next();
});

app.get("/", (req, res) => res.status(200).send("CashCarBC backend is running.\n"));

app.post("/twilio/voice", validateTwilioRequest, twilioVoice);
app.post("/twilio/collect", validateTwilioRequest, twilioCollect);

app.listen(PORT, () => console.log(`CashCarBC server listening on port ${PORT}`));
