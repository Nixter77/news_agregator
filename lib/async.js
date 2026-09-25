async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('budget exceeded')), ms);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run mapper over items with a concurrency cap. Stop waiting at deadlineAt
 * and return whatever finished; in-flight work keeps running (fills cache).
 */
function mapPoolWithDeadline(items, mapper, { concurrency, deadlineAt } = {}) {
  const results = Array.from({ length: items.length });
  const limit = Math.max(1, concurrency || 1);
  const timed = Number.isFinite(deadlineAt);

  return new Promise((resolve) => {
    let next = 0;
    let active = 0;
    let settled = false;

    const finish = (deadlineHit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ results, deadlineHit });
    };

    const timer = timed
      ? setTimeout(() => finish(true), Math.max(0, deadlineAt - Date.now()))
      : null;

    const launch = () => {
      if (settled) return;
      while (active < limit && next < items.length) {
        const index = next;
        next += 1;
        active += 1;
        Promise.resolve()
          .then(() => mapper(items[index], index))
          .then((value) => {
            if (!settled) results[index] = { ok: true, value };
          })
          .catch((error) => {
            if (!settled) results[index] = { ok: false, error };
          })
          .finally(() => {
            active -= 1;
            if (settled) return;
            if (next >= items.length && active === 0) finish(false);
            else launch();
          });
      }
    };

    if (items.length === 0) finish(false);
    else launch();
  });
}

module.exports = { withTimeout, mapPoolWithDeadline };
