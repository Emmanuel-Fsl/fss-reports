# FSS Reports

Reporting platform for Fintech Solutions Services — Next.js 14, Firebase Auth, BigQuery.

## Stack
- **Framework**: Next.js 14 (App Router)
- **Auth**: Firebase Auth (email/password)
- **Data**: Google BigQuery (`@google-cloud/bigquery`)
- **Exports**: CSV (server-streamed) · Excel (`xlsx`) · PDF (`jspdf` + `jspdf-autotable`)
- **Styling**: Tailwind CSS · Nunito Sans · Fira Code · `#2E7D32` green

---

## Getting started

```bash
npm install
cp .env.local.example .env.local
# fill in your Firebase + BQ credentials
npm run dev
```

## Adding a new report

Open `lib/reports/reports.config.ts` and add one object to the `REPORTS` array:

```ts
{
  id:       'my_new_report',
  label:    'My New Report',
  category: 'Collections',          // groups it in the sidebar
  tag:      'COL',
  desc:     'Short description shown under the title',
  bqKey:    'bq_my_new_report',     // matches a key in lib/bq/queries.ts
  filters:  ['institution', 'dateFrom', 'dateTo'],
  coreColumns: [
    { key: 'date',    label: 'Date',    type: 'date'     },
    { key: 'amount',  label: 'Amount',  type: 'currency' },
  ],
  extraColumns: [
    { key: 'agent', label: 'Agent', type: 'text' },
  ],
}
```

Then add the matching SQL builder to `lib/bq/queries.ts` under `QUERY_MAP`:

```ts
bq_my_new_report: ({ institution, dateFrom, dateTo }) => `
  SELECT ...
  FROM \`fssspark.your_dataset.your_table\`
  WHERE date BETWEEN '${dateFrom}' AND '${dateTo}'
`,
```

That's it — the report appears in the sidebar immediately, with filters, column toggles, and all three export formats wired up automatically.

---

## Institution-aware queries (like Recovery Report)

If the SQL changes based on institution (e.g. CREDIT DIRECT needs `SPLIT(...)`), use `buildQuery` in the config instead of adding to `QUERY_MAP`:

```ts
buildQuery: (filters) => {
  const loanExpr = filters.institution === 'CREDIT DIRECT'
    ? `SPLIT(ANY_VALUE(l.loan_id), '-')[SAFE_OFFSET(0)]`
    : `ANY_VALUE(l.loan_id)`
  return `SELECT ${loanExpr} AS \`Loan ID\`, ...`
}
```

---

## Environment variables

See `.env.local.example` — copy it to `.env.local` and fill in:

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_FIREBASE_*` | Firebase client config |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase Admin SDK service account (JSON string) |
| `BQ_PROJECT_ID` | BigQuery project ID (default: `fssspark`) |
| `GOOGLE_APPLICATION_CREDENTIALS_JSON` | BQ service account JSON string (for Vercel) |

## Deployment

Deploy to Vercel — add all env vars in the Vercel dashboard. The `@google-cloud/bigquery` package is marked as a server external in `next.config.js` so it only runs in API routes.
