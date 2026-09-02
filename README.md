# Cloud Centres Power Dashboard - Link Financial

Iframe-friendly live power dashboard for Link Financial Suite D Vertiv PDUs in Zabbix.

## Run

1. Keep the read-only Zabbix credentials in `ro.env`, or copy `example.env` to `.env`.
2. Start the app:

```powershell
node server.js
```

3. Add this URL to a Zabbix URL/iframe widget:

```text
http://<dashboard-host>:3000/
```

The app reads Zabbix host group `117` and renders the six Suite D rack/feed positions for `DR3P9`, `DR3P10`, and `DR3P11`.

During the Vertiv migration it prefers the new host naming pattern `Link-Financial.Rack-R3P9/R3P10/R3P11.(Green|Orange).PDU`. If a new Vertiv host is not present yet, it temporarily falls back to the old active host for that rack/feed and marks the card as awaiting Vertiv circuit monitoring.

## Capacity Model

The dashboard uses Vertiv per-circuit breaker current where available. Each PDU has six 16A circuits, and each circuit is assessed against a 16A ceiling:

- `OK`: below 80% of 16A.
- `Warning`: at or above 12.8A.
- `Alarm`: at or above 16A.

The dashboard also retains the three-phase resilience projection so each rack can still be reviewed for phase balance across the paired Green and Orange feeds.
