# Cloud Centres Power Dashboard - Link Financial

Iframe-friendly live power dashboard for Link Financial Suite D PDUs in Zabbix.

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

The app reads Zabbix host group `117` and only renders the six Suite D hosts matching `Link-Financial.Rack.R3P9/R3P10/R3P11.(Green|Orange).PDU`.

## Capacity Model

The dashboard uses the live per-phase current values because these PDUs do not expose per-outlet or breaker loading. Each phase is assessed against a conservative 16A ceiling:

- `OK`: below 80% of 16A.
- `Warning`: at or above 12.8A.
- `Alarm`: at or above 16A.

Each rack also includes a worst-case paired-PDU projection. That projection adds the paired PDU's present phase load onto each feed to show whether either PDU could carry the current paired phase load while remaining below 16A.
