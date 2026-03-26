/**
 * In-memory KV store that mimics the @vercel/kv API.
 *
 * This is a temporary replacement for @vercel/kv during the
 * Azure migration. It provides the same interface (get, set, incr, del, expire)
 * but stores data in process memory with TTL support.
 *
 * Limitations:
 * - Data is lost on cold start / function restart
 * - Not shared across function instances
 *
 * TODO: Replace with Azure Table Storage or Azure Redis Cache in Phase 3.
 */

const store = new Map();
const expiry = new Map();

function cleanup(key) {
  const exp = expiry.get(key);
  if (exp && Date.now() > exp) {
    store.delete(key);
    expiry.delete(key);
    return true;
  }
  return false;
}

const kv = {
  async get(key) {
    cleanup(key);
    const val = store.get(key);
    if (val === undefined) return null;
    return val;
  },

  async set(key, value, options) {
    store.set(key, value);
    if (options && options.ex) {
      expiry.set(key, Date.now() + options.ex * 1000);
    } else if (options && options.px) {
      expiry.set(key, Date.now() + options.px);
    }
    return 'OK';
  },

  async del(key) {
    store.delete(key);
    expiry.delete(key);
    return 1;
  },

  async incr(key) {
    cleanup(key);
    let val = store.get(key);
    if (val === null || val === undefined) val = 0;
    val = parseInt(val) + 1;
    store.set(key, val);
    return val;
  },

  async expire(key, seconds) {
    if (store.has(key)) {
      expiry.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  },

  async ttl(key) {
    const exp = expiry.get(key);
    if (!exp) return -1;
    const remaining = Math.ceil((exp - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  },

  async exists(key) {
    cleanup(key);
    return store.has(key) ? 1 : 0;
  },
};

module.exports = { kv };
