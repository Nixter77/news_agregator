const metrics = {
  rateLimited: 0,
  upstreamFail: 0,
  translateFail: 0,
  translateRateLimited: 0,
};

function recordMetric(name) {
  if (Object.prototype.hasOwnProperty.call(metrics, name)) {
    metrics[name] += 1;
  }
}

module.exports = { metrics, recordMetric };
