const NodeCache = require("node-cache");

const streamCache = new NodeCache({ stdTTL: 3600, checkperiod: 120 });
const searchCache = new NodeCache({ stdTTL: 600 });

const getRemainingTtlMs = (cache, key) => {
  const ttl = cache.getTtl(key);
  return ttl ? ttl - Date.now() : Infinity;
};

module.exports = { streamCache, searchCache, getRemainingTtlMs };