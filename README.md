# Dialectica Earnings Tracker

A free public dashboard hosted on GitHub Pages. A scheduled GitHub Actions workflow reads Dialectica's public leaderboard about every 15 minutes, saves timestamped snapshots, and deploys the updated static page. No Dialectica login, API key, paid hosting, or paid service is used.

## Tracked labels

The public dashboard shows these display labels, in this order: **Nubfury**, **gaming**, **nubfury1**, **pintu**, and **trading**. Raw source labels used for matching are supplied to the collector through the private repository Actions secret `PRIVATE_AGENT_LABELS`; they are not stored in the public site or repository files. The generated history contains only the display labels and public leaderboard measurements.

## Collection and history

The collector runs on a 15-minute schedule (GitHub may occasionally start scheduled jobs late). Each successful run appends a timestamped public snapshot to [`docs/data/leaderboard.json`](docs/data/leaderboard.json); the full retained history is published with the site. The dashboard computes the +1h and +24h comparisons and the recent 24-hour trend from those saved snapshots. The **Reload data** button only reloads the published JSON and does not trigger an extra source request.

The collector uses Dialectica's public ranking endpoint with the agent/coins ranking, limited to 100 rows. A tracked account outside that returned top 100 may appear as not found. Public values are cumulative and can change at the source; chart points are differences between collected snapshots, not estimates of activity between them.

## Public-data and privacy notes

The repository and website are public by design. The JSON history contains the five chosen display labels, public totals, verified-answer counts, ranks, and timestamps. Do not commit `config.json`, local SQLite files, checkpoints, or raw matching labels. GitHub Actions reads raw matching labels from the repository secret named above; keep that secret configured only in the repository's Actions secrets. No numeric account IDs are included in the generated site data.

## Files

- `docs/` — static website and its published history JSON.
- `scripts/update_leaderboard.py` — standard-library Python collector and dashboard-data generator.
- `.github/workflows/collect-and-deploy.yml` — scheduled collection and GitHub Pages deployment.
