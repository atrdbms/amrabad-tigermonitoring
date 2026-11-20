/**
 * Amrabad Tiger Reserve – Tiger Monitoring Management System
 * Edit service: lets the website edit records, add new records and upload photos.
 *
 * ONE-TIME SETUP (see README "Editing records & adding photos"):
 *   1. Open the Google Sheet → Extensions → Apps Script. Delete any code there and paste this file.
 *   2. Change EDIT_PASSWORD below to your own password (share it only with staff who may edit).
 *   3. Deploy → New deployment → type "Web app"
 *        Execute as: Me      Who has access: Anyone
 *      → Deploy → Authorize access (allow Sheets + Drive) → copy the Web app URL (ends in /exec).
 *   4. Paste that URL into config.js → editApiUrl on the website, and upload config.js to GitHub.
 * After changing this code later: Deploy → Manage deployments → Edit (pencil) → Version: New version → Deploy.
 */

const EDIT_PASSWORD = 'change-this-password';   // <-- CHANGE THIS
const SHEET_NAME = 'Sheet1';                     // tab that holds the records
const KEY_COLUMN = 'Sl_No';                      // unique number of each record
const PHOTO_URL_COLUMN = 'photo_URL';            // link written here after upload
const PHOTO_NAME_COLUMN = 'Photo';               // file name written here
const PHOTO_FOLDER = 'Tiger monitoring database_Images'; // Drive folder for uploaded photos

function doGet() {
  return json_({ ok: true, message: 'ATR Tiger Monitoring edit service is running.' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const req = JSON.parse(e.postData.contents);
    if (String(req.password || '') !== EDIT_PASSWORD) return json_({ ok: false, error: 'Wrong edit password.' });
    if (req.action === 'ping') return json_({ ok: true });

    const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
    if (!sh) return json_({ ok: false, error: 'Sheet "' + SHEET_NAME + '" not found.' });
    const lastCol = sh.getLastColumn();
    const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
    const keyIdx = headers.indexOf(KEY_COLUMN);
    if (keyIdx < 0) return json_({ ok: false, error: 'Column "' + KEY_COLUMN + '" not found.' });

    const lastRow = sh.getLastRow();
    const keys = lastRow > 1 ? sh.getRange(2, keyIdx + 1, lastRow - 1, 1).getDisplayValues().map(function (r) { return String(r[0]).trim(); }) : [];
    const values = Object.assign({}, req.values || {});
    let rowNum, key;

    if (req.action === 'add') {
      const max = keys.reduce(function (m, k) { return Math.max(m, Number(k) || 0); }, 0);
      key = String(max + 1);
      values[KEY_COLUMN] = key;
      rowNum = lastRow + 1;
    } else if (req.action === 'update') {
      key = String(req.key).trim();
      const i = keys.indexOf(key);
      if (i < 0) return json_({ ok: false, error: 'Record ' + key + ' not found in the sheet.' });
      rowNum = i + 2;
      delete values[KEY_COLUMN];
    } else {
      return json_({ ok: false, error: 'Unknown action.' });
    }

    if (req.photo && req.photo.data) {
      const folder = photoFolder_();
      const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
      const name = key + '.Photo.' + stamp + '.jpg';
      const blob = Utilities.newBlob(Utilities.base64Decode(req.photo.data), req.photo.mime || 'image/jpeg', name);
      const file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err) { /* domain policy may block */ }
      const link = 'https://drive.google.com/open?id=' + file.getId();
      const old = req.keepOldPhotos && rowNum <= lastRow && headers.indexOf(PHOTO_URL_COLUMN) >= 0
        ? String(sh.getRange(rowNum, headers.indexOf(PHOTO_URL_COLUMN) + 1).getDisplayValue()).trim() : '';
      values[PHOTO_URL_COLUMN] = old ? old + ' ' + link : link;
      values[PHOTO_NAME_COLUMN] = PHOTO_FOLDER + '/' + name;
    }

    // write only the cells that were sent (other columns and formulas are left untouched)
    headers.forEach(function (h, c) {
      if (!Object.prototype.hasOwnProperty.call(values, h)) return;
      const v = values[h] == null ? '' : String(values[h]);
      const cell = sh.getRange(rowNum, c + 1);
      if (/^-?\d+(\.\d+)?$/.test(v)) cell.setValue(Number(v)); else cell.setValue(v);
    });
    if (req.action === 'add') sh.getRange(rowNum, keyIdx + 1).setValue(Number(key));

    return json_({ ok: true, key: key, row: rowNum, values: values });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

function photoFolder_() {
  const it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
