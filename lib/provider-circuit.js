class ProviderCircuit {
  constructor({ now = Date.now, onFailure = () => {} } = {}) {
    this.now = now; this.onFailure = onFailure;
    this.failures = 0; this.openUntil = 0; this.busy = false;
  }
  status() { return { failures: this.failures, retry_at: this.openUntil ? new Date(this.openUntil).toISOString() : null, open: this.now() < this.openUntil, busy: this.busy }; }
  async run(operation) {
    if (this.busy || this.now() < this.openUntil) throw Object.assign(new Error('Provider temporarily unavailable'), { circuitOpen:true });
    this.busy = true;
    try {
      const result = await operation();
      this.failures = 0; this.openUntil = 0;
      return result;
    } catch(error) {
      this.failures++;
      const configurationFailure = [400,401,402,403].includes(error.statusCode);
      // Even the first transient failure gets backoff. No immediate paid retries.
      this.openUntil = this.now() + (configurationFailure ? 900000 : Math.min(900000, 30000 * 2 ** (this.failures-1)));
      this.onFailure(error, this.status());
      throw error;
    } finally { this.busy = false; }
  }
}
module.exports = { ProviderCircuit };
