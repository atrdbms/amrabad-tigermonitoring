# Amrabad Tiger Reserve – Tiger Monitoring Management System

A static website (no server, no database) that reads the published Google Sheet
live every time the page opens, so new rows in the sheet show up automatically.

## Files
- `index.html` – the page
- `config.js`  – **the only file you normally edit**: titles, logos, sheet link, map start point, column names
- Logos (ATR and Government of Telangana emblem) are built into `index.html`; no image files to upload.
- `app.js`     – filtering, map, report and export logic
- `style.css`  – look and print layout

## Pages
- **Dashboard** – KPI cards, month-wise / range-wise / per-tiger charts, location overview map, latest records.
- **GIS Map** – full satellite map with legend, popups, photos and movement lines.
- **Tiger Profiles** – one card per tiger: latest photo, records, first/last seen, ranges, beats.
- **Reports** – printable report on letterhead with both logos and signature lines.
- **Records** – the full sheet as a sortable table.

## Features
- Filter panel (M-STrIPES style): choose values, then press **Apply Filter**. Cascading filters: Year, Month, Tiger ID, Division, Range, Section, Beat, Block, Compt. No,
  With photo / Without photo, plus free-text search. Each dropdown shows record counts and
  only lists values that exist for the other filters chosen.
- Google Satellite (with labels) basemap, plus Google Satellite, Terrain, Esri imagery and OSM.
  Points are coloured per tiger; a yellow ring marks records with a photo. Click a point for
  all sheet details and photos (click a photo to enlarge). Optional movement lines per tiger.
- Detailed report: summary counts, tiger-wise, range-wise, beat-wise, month-wise tables,
  Tiger × Range matrix and record list. Print / Save as PDF (A4 landscape), Excel export
  (one sheet per table) and CSV export of the filtered records.
- Records tab: full sheet table, sortable; clicking a row zooms the map to it.

## Sheet requirements
- Keep the sheet published: File → Share → Publish to web → the tab → CSV.
- Latitude/Longitude can be decimal (16.3512) or degrees-minutes-seconds (16°17'30.2"N).
- Photo column: Google Drive links (open?id=… or file/d/…/view) or any image URL. Several
  links in one cell can be separated by commas or spaces. Drive photos must be shared as
  "Anyone with the link – Viewer" to display. Blank / "No" / "NA" / "-" count as *without photo*.
- If Year or Month columns are blank, they are taken from a Date column (dd/mm/yyyy).
- If a header name differs from the ones listed in `config.js`, add it to the list there.
  The status bar at the top right reports any filter column it could not find.

## Publishing (free) on GitHub Pages
1. Create a GitHub repository (e.g. `atr-tiger-monitoring`) and upload these four files.
2. Settings → Pages → Source: *Deploy from a branch* → `main` / root → Save.
3. The site appears at `https://<your-username>.github.io/atr-tiger-monitoring/`.

Any static host works too (Netlify drop, Google Sites embed, a department web server).
To try it on your own computer, open a terminal in this folder and run
`python -m http.server 8000`, then visit http://localhost:8000.

Note: Google's satellite tiles are used directly, which is fine for internal use; for a
high-traffic public site, Google's terms expect the official Maps JavaScript API with a key.
The Esri World Imagery layer is a ready alternative in the layer switcher.

## Photos on the map
Records with a link in `photo_URL` show as a 📷 pin. Click the pin to see the photo
(click the photo to enlarge). Google Drive photos must be shared as
"Anyone with the link – Viewer", otherwise they cannot be displayed.

## Tiger profile photos
Each tiger card shows, in this order of priority:
1. A photo set with the **📷 Set photo** button on the card (saved only in that browser).
2. A photo from a **Tiger_Profiles** tab in the Google Sheet (shown to everyone):
   - Add a new tab named `Tiger_Profiles` with columns `Tiger_ID | Profile_Photo_URL | Name | Remarks`.
   - Put one row per tiger, e.g. `ATR M 19 | https://drive.google.com/file/d/…/view | | Resident male`.
   - File → Share → Publish to web → choose the `Tiger_Profiles` tab → CSV → Publish, copy the link.
   - Paste the link in `config.js` → `profileCsvUrl`.
3. A photo listed in `config.js` → `profilePhotos`.
4. Otherwise the latest record photo of that tiger.

## Reports
The Abstract Reports page has three tabs, all following the current filters:
- **Abstract report** – fixed summary tables (tiger-, range-, beat-, month-wise, year × month, etc.).
- **Custom report** – tick the columns you want, choose sort order, then Excel / CSV / Print-PDF.
  Default ticked columns are set in `config.js` → `customDefaultColumns`.
- **Pivot abstract** – count records or individual tigers by any two columns (e.g. Range × Year).
