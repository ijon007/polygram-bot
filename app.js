/**
 * Vercel Node build entrypoint. The webhook handler is implemented in api/bot.js
 * and mounted at POST /api/bot (and POST / for compatibility).
 */
module.exports = require("./api/bot");
