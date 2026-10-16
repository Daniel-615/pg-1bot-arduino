require("dotenv").config({ quiet: true });

module.exports = {
  PORT: process.env.PORT,
  SECRET_JWT_KEY: process.env.SECRET_JWT_KEY,
  LOCAL_AGENT_MODE: process.env.LOCAL_AGENT_MODE === "true" || Boolean(process.pkg),
};
