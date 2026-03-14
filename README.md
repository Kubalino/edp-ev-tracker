# ⚡ EDP EV Charging Tracker

A browser-based dashboard to track EV charging costs using EDP's **tri-horária** tariff (Vazio / Cheias / Ponta) in Portugal.

![Dashboard Preview](docs/screenshot.png)

## Features

- **OneDrive Sync** — Reads your CSV directly from a OneDrive folder via Microsoft Graph API; sign in once with your Microsoft account and sync on demand
- **CSV Import** — Upload charging session CSVs manually from your EV charger app
- **Auto Period Classification** — Each session is split into Vazio/Cheias/Ponta based on EDP's official *ciclo diário* schedule, accounting for:
  - Time of day
  - Weekday vs weekend (no Ponta on weekends)
  - Winter vs Summer schedules
  - Sessions spanning multiple periods (proportional split)
- **Cost Calculation** — Per-session and monthly energy costs with IVA
- **Dashboard** — Monthly cost trends, cost by period, kWh breakdown, per-session averages
- **Persistent Storage** — IndexedDB stores all data locally in your browser
- **Backup/Restore** — Export & import JSON backups, CSV exports
- **Rate Management** — Pre-loaded EDP 2026 rates with manual override
- **Duplicate Detection** — Re-importing the same CSV won't create duplicate entries

## CSV Format

The parser auto-detects your CSV format. Currently supported:

### Event format (from EV chargers):
```csv
Time,Start:,End:,Duration:,Charged:(kWh)
2026-03-06 10:46:18,10:46,11:39,00:52:56,2.2
2026-03-04 11:50:33,11:50,16:00,03:58:52,7.2
```

### Monthly aggregate format:
```csv
Mês;kWh Vazio;kWh Cheias;kWh Ponta
2025-01;180.5;120.3;45.2
```

Both `,` and `;` separators are supported.

## EDP Tri-Horária Schedule (Ciclo Diário)

### Winter (November – March)
| Period | Weekdays | Weekends |
|--------|----------|----------|
| Vazio | 00:00–08:00, 22:00–24:00 | 00:00–08:00, 22:00–24:00 |
| Cheias | 08:00–09:30, 12:00–18:30, 21:00–22:00 | 08:00–22:00 |
| Ponta | 09:30–12:00, 18:30–21:00 | — |

### Summer (April – October)
| Period | Weekdays | Weekends |
|--------|----------|----------|
| Vazio | 00:00–08:00, 22:00–24:00 | 00:00–08:00, 22:00–24:00 |
| Cheias | 08:00–10:30, 13:00–19:30, 21:00–22:00 | 08:00–22:00 |
| Ponta | 10:30–13:00, 19:30–21:00 | — |

## Live App

**https://Kubalino.github.io/edp-ev-tracker/**

Deployed automatically via GitHub Actions on every push to `main`.

## OneDrive Sync Setup

The app can read your CSV directly from OneDrive. One-time setup required:

1. Register a free app at [portal.azure.com](https://portal.azure.com) → App registrations
2. Set account type to "Any Entra ID Tenant + Personal Microsoft accounts"
3. Add redirect URIs (Single-page application): `http://localhost:5173/` and your GitHub Pages URL
4. Add API permission: Microsoft Graph → Delegated → `Files.Read`
5. Paste the Application (client) ID into `OD_CLIENT_ID` in `src/App.jsx`

Then in the app: go to **Import tab** → enter your OneDrive file path (e.g. `EV-Tracker/charges.csv`) → click Sync.

## Getting Started (local dev)

```bash
# Install dependencies
npm install

# Run dev server
npm run dev

# Build for production
npm run build
```

## Tech Stack

- **React 18** + Vite
- **Recharts** — Charts
- **IndexedDB** — Local persistence (no server needed)
- **@azure/msal-browser** — Microsoft authentication for OneDrive sync
- **GitHub Actions** — Automated deployment to GitHub Pages

## Pre-loaded Rates (2026 estimate)

| Period | €/kWh |
|--------|-------|
| Ponta | 0.3250 |
| Cheias | 0.1729 |
| Vazio | 0.1045 |

> These are approximate values for EDP Eletricidade Verde, 6.9 kVA.
> Update them in the Tarifas tab to match your actual contract.

## Data Privacy

Charging data is stored **locally in your browser** using IndexedDB. The only external communication is the OneDrive sync feature, which reads your CSV directly from your own Microsoft account — no third-party servers involved. Use the backup/restore feature to move data between devices.

## License

MIT
