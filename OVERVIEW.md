Shows Kimi Code plan quota in Paseo's existing Settings → Usage view, alongside other provider accounts. It reports rolling 5-hour, weekly, and monthly windows when Kimi supplies them, including reset times.

Requires Paseo 0.11.0 or later and an existing Kimi Code CLI login on the daemon host. The plugin discovers `KIMI_TOKEN` or `KIMI_API_KEY`, plus the standard Kimi credential files. `KIMI_CODE_HOME` and `KIMI_CODE_BASE_URL` overrides are respected.

The plugin reads the current credential on each refresh and calls only Kimi's read-only `/coding/v1/usages` endpoint. Tokens are not logged, sent elsewhere, refreshed, or rewritten. Use Kimi's login flow when the credential expires.

Kimi's quota response is undocumented and may change. Available windows vary by membership. Monthly Code usage is a share of the monthly total, not an additional quota pool.
