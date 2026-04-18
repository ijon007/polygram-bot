/**
 * Vercel Node build entrypoint. The webhook handler is implemented in api/bot.js
 * and mounted at POST /api/bot (and POST / for compatibility).
 *
 * Vercel's static analysis requires this file to import `express` directly
 * (re-exporting from api/bot.js is not enough).
 */
require("express");
module.exports = require("./api/bot");
