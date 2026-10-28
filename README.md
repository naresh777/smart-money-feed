# Smart money feed

A daily JSON feed of public "smart money" filings, used by StockApp's Smart tab:

- **SEC Form 4:** open-market insider purchases from the last 45 days.
- **SEC 13F:** latest holdings, and changes from the previous quarter, for 17 well-known funds.
- **House of Representatives:** periodic transaction reports from the last 60 days.
- **Context:** price, liquidity and trend for every ticker listed.

**Feed:** https://naresh777.github.io/smart-money-feed/smart-feed.json (about 2 MB, about 0.4 MB compressed)
**Last run:** [status.json](status.json)

The feed rebuilds Tuesday to Saturday at 10:30 UTC (**Actions > Build feed**, or run it by hand). Each run reads only the filings that are new since the live file was made.

Everything here is public, legally disclosed information, published days (Form 4) to weeks (13F, Congress) after the trade. It is not investment advice.

## Setup

- Add a `SEC_USER_AGENT` repository secret with a real name and email, for example `Jane Doe jane@example.com`. The SEC requires this. Without it, the Form 4 and 13F parts are skipped.
- Under **Settings > Pages**, set the source to **GitHub Actions**.
