// Paste this into your Google Sheet: Extensions → Apps Script → replace everything → Save.
// Then Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).

// Must be exactly the same as SHEET_SECRET on Render. Change it here only in Google, never commit the real value.
const SECRET = 'PASTE-YOUR-SECRET-HERE';
const SHEET_NAME = 'Պատասխաններ';

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  if (body.secret !== SECRET) return json({ ok: false, error: 'unauthorized' });

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSheet();
    const record = body.record;

    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['ID', 'Ամսաթիվ'].concat(body.columns.map((c) => c[0]), ['JSON']));
      sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    // The server retries on network errors, so skip an id that is already saved.
    const exists = sheet.getRange('A:A').createTextFinder(record.id).matchEntireCell(true).findNext();
    if (!exists) {
      sheet.appendRow([record.id, record.submittedAt].concat(body.columns.map((c) => c[1]), [JSON.stringify(record)]));
    }
    return json({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

// Used by the admin page to load all answers.
function doGet(e) {
  if (e.parameter.secret !== SECRET) return json({ error: 'unauthorized' });
  const sheet = getSheet();
  const rows = sheet.getLastRow() - 1;
  if (rows < 1) return json({ responses: [] });

  const jsonCol = sheet.getLastColumn();
  const responses = sheet.getRange(2, jsonCol, rows, 1).getValues()
    .map((r) => r[0])
    .filter(Boolean)
    .map((text) => JSON.parse(text));
  return json({ responses });
}

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
