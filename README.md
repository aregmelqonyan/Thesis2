# Մարդ-համակարգիչ փոխազդեցության կիրառությունները ռիսկերի կառավարման ոլորտում

Research survey (one-pager) for the thesis — banking & credit risk + HCI.

## Run

```bash
npm install
npm start            # http://localhost:3000
```

- Survey page: `http://localhost:3000`
- Admin dashboard: `http://localhost:3000/admin` (default password `admin123`)

Set your own admin password and port:

```bash
ADMIN_TOKEN="your-secret" PORT=8080 npm start
```

## Where answers are stored

No database — every submission is appended to `data/responses.json`
(writes are serialized and atomic, so the file is never corrupted).
The admin page shows charts and exports **CSV** (opens in Excel / SPSS) and **JSON**.

## Keeping answers permanently (Google Sheets)

Free hosting (e.g. Render free) wipes `data/responses.json` on every restart. To keep every answer,
the server also sends each one to your own Google Sheet, and the admin page reads from it.

1. Create a new Google Sheet → **Extensions → Apps Script**.
2. Paste the contents of `google-apps-script/Code.gs`, set `SECRET` to a long random password, **Save**.
3. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone** → **Deploy**, allow access, copy the Web app URL.
4. On Render → **Environment**, add:
   - `GOOGLE_SHEET_URL` = the Web app URL
   - `SHEET_SECRET` = the same password as `SECRET` in the script
5. Submit a test answer — a row appears in the sheet tab «Պատասխաններ».

## Structure

| File | Purpose |
|---|---|
| `survey.js` | All questions (edit here — the page and the validation update automatically) |
| `server.js` | Express backend: serves the page, validates and saves answers, admin API |
| `public/index.html`, `styles.css`, `app.js` | Survey page |
| `public/admin.*` | Admin dashboard |

## HCI interaction data

Besides answers, each response records anonymous interaction metrics:
total completion time, time spent in each section, first/last interaction time and
number of changes per question, screen size and touch vs. mouse.
Every section, question and Likert row has a `data-aoi` attribute, so it can be used
as an Area of Interest for eye-tracking software.
