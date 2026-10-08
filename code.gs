/**
 * ==========================================
 * UPI PAYMENT VERIFICATION 
 * ==========================================
 * See README.md for setup, security notes, quota reference, and full
 * Android / Web / Bot integration demos.
 */

// ==========================================
// CONFIG
// Loaded fresh from Script Properties at the start of every request/run
// (one PropertiesService call, not one per property) so that changing a
// property takes effect on the very next request - no redeploy needed.
// ==========================================
var PROPS = PropertiesService.getScriptProperties();
var TOKEN_REGEX = /^[A-Z0-9]{8,16}$/;
var MAX_ORDER_AMOUNT = 1000000; // sanity cap, adjust to your business

function loadConfig() {
  var p = PROPS.getProperties();
  return {
    UPI_ID: p.UPI_ID,
    PAYEE_NAME: p.PAYEE_NAME,
    API_CREATE_SECRET: p.API_CREATE_SECRET,
    WEBHOOK_SECRET: p.WEBHOOK_SECRET,
    WEBHOOK_URL: p.WEBHOOK_URL,
    SHEET_ID: p.SHEET_ID,
    ADMIN_SECRET: p.ADMIN_SECRET,
    MERCHANT_EMAIL: p.MERCHANT_EMAIL, // optional
    NOTIFY_ON_SUCCESS: (p.NOTIFY_ON_SUCCESS || 'false').toLowerCase() === 'true',
    NOTIFY_ON_MISMATCH: (p.NOTIFY_ON_MISMATCH || 'true').toLowerCase() === 'true',
    ORDER_EXPIRY_MINUTES: Number(p.ORDER_EXPIRY_MINUTES) || 30
  };
}

// Run manually from the Apps Script editor (select checkConfig, click
// Run) after setting Script Properties, to catch typos/missing values
// early instead of cryptic runtime errors later.
function checkConfig() {
  var cfg = loadConfig();
  var requiredKeys = ['UPI_ID', 'PAYEE_NAME', 'API_CREATE_SECRET', 'WEBHOOK_SECRET',
    'WEBHOOK_URL', 'SHEET_ID', 'ADMIN_SECRET'];
  var missing = requiredKeys.filter(function (k) { return !cfg[k]; });

  if (missing.length > 0) {
    var msg = 'Missing Script Properties: ' + missing.join(', ');
    console.error(msg);
    throw new Error(msg);
  }
  var sheet = getDatabaseSheet(cfg);
  console.log('Config OK. Sheet "' + sheet.getName() + '" reachable, ' + sheet.getLastRow() + ' rows.');
  return 'Config OK';
}

function getDatabaseSheet(cfg) {
  if (!cfg.SHEET_ID) throw new Error('SHEET_ID script property is not set.');
  return SpreadsheetApp.openById(cfg.SHEET_ID).getActiveSheet();
}

function getLogsSheet(cfg) {
  var ss = SpreadsheetApp.openById(cfg.SHEET_ID);
  var sheet = ss.getSheetByName('Logs');
  if (!sheet) {
    sheet = ss.insertSheet('Logs');
    sheet.appendRow(['Timestamp', 'Event', 'Detail', 'Context']);
    sheet.getRange('A1:D1').setFontWeight('bold');
  }
  return sheet;
}

// ==========================================
// SECURITY HELPERS
// ==========================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Safely embeds a JS value inside an inline <script> block: JSON.stringify
// handles quote/backslash escaping, and we additionally neutralize "</"
// so a value can never prematurely close the surrounding <script> tag.
function toScriptLiteral(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/');
}

// Prevents Google Sheets/CSV formula injection: if a value written into a
// cell starts with = + - @ (or a tab/CR), Sheets can interpret it as a
// formula. Applies to any value derived from outside input - the
// client-supplied IP and the bank email's extracted "sender" text.
function sanitizeForSheet(value) {
  var str = String(value == null ? '' : value);
  if (/^[=+\-@\t\r]/.test(str)) return "'" + str; // leading apostrophe forces text
  return str;
}

function isValidToken(token) {
  return typeof token === 'string' && TOKEN_REGEX.test(token);
}

// Loose IPv4/IPv6 sanity check - used only to decide whether to log the
// value as-is or flag it as "Unrecognized", never to authorize/deny.
function isPlausibleIp(ip) {
  if (typeof ip !== 'string' || ip.length > 45) return false;
  return /^[0-9a-fA-F:.]+$/.test(ip);
}

function verifyAdminSecret(cfg, e) {
  return !!cfg.ADMIN_SECRET && safeEquals(String(e.parameter.admin_secret || ''), String(cfg.ADMIN_SECRET));
}

// Simple constant-time-ish compare to avoid the most naive short-circuit
// timing leak from a plain === on secrets compared against user input.
function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Small fixed-window rate limiter using CacheService.
function checkRateLimit(key, maxRequests, windowSeconds) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'RATE_' + key;
  var current = cache.get(cacheKey);
  var count = current ? parseInt(current, 10) : 0;
  if (count >= maxRequests) return false;
  cache.put(cacheKey, String(count + 1), windowSeconds);
  return true;
}

function logSecurityEvent(cfg, event, detail, context) {
  try {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) return;
    try {
      getLogsSheet(cfg).appendRow([
        new Date(),
        sanitizeForSheet(event),
        sanitizeForSheet(detail),
        sanitizeForSheet(context || '')
      ]);
    } finally {
      lock.releaseLock();
    }
  } catch (e) {
    console.error('logSecurityEvent failed: ' + e.toString());
  }
}

// For DeepLink Creation
function buildUpiLink(cfg, token, amount) {
  return 'upi://pay?pa=' + encodeURIComponent(cfg.UPI_ID) +
    '&pn=' + encodeURIComponent(cfg.PAYEE_NAME) +
    '&am=' + encodeURIComponent(amount) +
    '&cu=INR' +
    '&tr=' + encodeURIComponent(token) +
    '&tn=' + encodeURIComponent('Order ' + token);
}

// ==========================================
// BACKGROUND CHECKER
// ==========================================
function recoverLostPayments() {
  var cfg = loadConfig();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;

  try {
    var sheet = getDatabaseSheet(cfg);
    var data = sheet.getDataRange().getValues();
    var now = new Date();

    for (var i = 1; i < data.length; i++) {
      var status = String(data[i][4]).toUpperCase();
      if (status !== 'PENDING') continue;

      var timestamp = data[i][0];
      var token = data[i][1];
      var expectedAmount = Number(data[i][2]);
      if (!isValidToken(token)) continue;

      var ageMinutes = (now - new Date(timestamp)) / 60000;
      if (ageMinutes > cfg.ORDER_EXPIRY_MINUTES) {
        sheet.getRange(i + 1, 5).setValue('Expired');
        continue;
      }

      var body = fetchConfirmationEmailBody(token);
      if (!body) continue;

      var extracted = smartExtract(body);
      var isFraud = extracted.amount < expectedAmount;

      if (isDuplicateUtr(cfg, extracted.utr, token)) {
        sheet.getRange(i + 1, 5).setValue('Duplicate-UTR');
        logSecurityEvent(cfg, 'duplicate_utr', extracted.utr, token);
        continue;
      }

      var newStatus = isFraud ? 'Mismatch' : 'Success';
      sheet.getRange(i + 1, 5).setValue(newStatus);
      sheet.getRange(i + 1, 6).setValue(sanitizeForSheet(extracted.sender));
      sheet.getRange(i + 1, 7).setValue(sanitizeForSheet(extracted.utr));
      sheet.getRange(i + 1, 8).setValue(sanitizeForSheet(extracted.txnId));

      if (!isFraud) {
        sendSecureWebhookOnce(cfg, {
          status: 'success', token: token, expected: expectedAmount,
          paid: extracted.amount, sender: extracted.sender,
          utr: extracted.utr, txnId: extracted.txnId, isFraud: false
        });
        if (cfg.NOTIFY_ON_SUCCESS) notifyMerchant(cfg, 'Payment received: ' + token,
          'Order ' + token + ' for Rs.' + expectedAmount + ' confirmed via sweeper.');
      } else if (cfg.NOTIFY_ON_MISMATCH) {
        notifyMerchant(cfg, 'Amount mismatch: ' + token,
          'Order ' + token + ' expected Rs.' + expectedAmount + ' but received Rs.' + extracted.amount + '.');
      }
    }
  } catch (e) {
    console.error('Sweeper failed: ' + e.toString());
    logSecurityEvent(cfg, 'sweeper_error', e.toString(), '');
  } finally {
    lock.releaseLock();
  }
}

// Separate lightweight trigger you can schedule hourly to keep the sheet
// tidy even if recoverLostPayments is scheduled less often.
function expireOldOrders() {
  var cfg = loadConfig();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var sheet = getDatabaseSheet(cfg);
    var data = sheet.getDataRange().getValues();
    var now = new Date();
    var expiredCount = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][4]).toUpperCase() !== 'PENDING') continue;
      var ageMinutes = (now - new Date(data[i][0])) / 60000;
      if (ageMinutes > cfg.ORDER_EXPIRY_MINUTES) {
        sheet.getRange(i + 1, 5).setValue('Expired');
        expiredCount++;
      }
    }
    if (expiredCount > 0) console.log('Expired ' + expiredCount + ' stale orders.');
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// ENTRY POINTS
// GET is supported for quick testing (curl / browser address bar) and
// for the two non-sensitive actions (ping, checkout). POST is the
// recommended way to call anything that carries a secret
// (createOrder, verify, status) since a POST body doesn't get written
// into browser history, server access logs, or Referer headers the way
// a URL query string does.
// ==========================================
function doGet(e) {
  var cfg = loadConfig();
  try {
    var action = e.parameter.action;

    if (action === 'ping') return respond({ status: 'ok', time: new Date().toISOString() });
    if (action === 'createOrder') return handleCreateOrder(cfg, e);
    if (action === 'checkout') return handleCheckout(cfg, e);
    if (action === 'verify') return handleVerify(cfg, e);
    if (action === 'status') return handleAdminStatus(cfg, e);

    return respond({ status: 'error', message: 'Invalid action' });
  } catch (error) {
    console.error('doGet error: ' + error.toString());
    logSecurityEvent(cfg, 'doGet_error', error.toString(), JSON.stringify(e.parameter));
    return respond({ status: 'error', message: 'Server fault' });
  }
}

// Accepts a JSON body ({"action":"verify",...}) or a normal form POST.
// Every handler already just reads e.parameter.X, so we normalize both
// shapes into that same form and reuse the exact same handlers as doGet.
function doPost(e) {
  var cfg = loadConfig();
  try {
    var params = e.parameter || {};
    if (e.postData && e.postData.contents) {
      try {
        var parsed = JSON.parse(e.postData.contents);
        if (parsed && typeof parsed === 'object') params = parsed;
      } catch (parseErr) {
        // Not JSON - fall back to whatever e.parameter already has
        // (a regular application/x-www-form-urlencoded POST).
      }
    }
    var fakeE = { parameter: params };
    var action = params.action;

    if (action === 'createOrder') return handleCreateOrder(cfg, fakeE);
    if (action === 'verify') return handleVerify(cfg, fakeE);
    if (action === 'status') return handleAdminStatus(cfg, fakeE);

    return respond({ status: 'error', message: 'Invalid action' });
  } catch (error) {
    console.error('doPost error: ' + error.toString());
    logSecurityEvent(cfg, 'doPost_error', error.toString(), '');
    return respond({ status: 'error', message: 'Server fault' });
  }
}

// ==========================================
// ROUTE: CREATE ORDER
// Only ever call this from YOUR backend - it requires API_CREATE_SECRET.
// Never ship this secret inside an Android app, a bot, or browser JS.
// ==========================================
function handleCreateOrder(cfg, e) {
  if (!safeEquals(String(e.parameter.api_secret || ''), String(cfg.API_CREATE_SECRET || ''))) {
    logSecurityEvent(cfg, 'unauthorized_create', 'bad api_secret', e.parameter.ip || '');
    return respond({ status: 'error', message: 'UNAUTHORIZED' });
  }

  var ip = e.parameter.ip || 'Unknown IP';
  if (!isPlausibleIp(ip)) ip = 'Unrecognized';

  if (!checkRateLimit('createOrder_' + ip, 10, 60)) {
    logSecurityEvent(cfg, 'rate_limited', 'createOrder', ip);
    return respond({ status: 'error', message: 'Rate limit exceeded, try again shortly' });
  }

  var amount = Number(e.parameter.amount);
  if (!isFinite(amount) || amount <= 0 || amount > MAX_ORDER_AMOUNT) {
    return respond({ status: 'error', message: 'Invalid amount' });
  }
  amount = Math.round(amount * 100) / 100;

  var token = Utilities.getUuid().replace(/-/g, '').substring(0, 12).toUpperCase();
  var sessionKey = Utilities.getUuid().substring(0, 8);

  var orderData = { amount: amount, status: 'pending', sessionKey: sessionKey };
  CacheService.getScriptCache().put('ORDER_' + token, JSON.stringify(orderData), 1800);

  logInitialOrder(cfg, token, amount, ip);

  var webAppUrl = ScriptApp.getService().getUrl();

  // Everything a client needs in one response - an Android app or bot
  // never has to touch the HTML checkout page at all if it doesn't want
  // to; it can launch upiLink directly and poll with token+sessionKey.
  return respond({
    status: 'success',
    token: token,
    sessionKey: sessionKey,
    amount: amount,
    upiLink: buildUpiLink(cfg, token, amount),
    checkoutUrl: webAppUrl + '?action=checkout&token=' + token,
    webAppUrl: webAppUrl
  });
}

// ==========================================
// ROUTE: CHECKOUT UI (browser-facing QR page)
// ==========================================
function handleCheckout(cfg, e) {
  var token = e.parameter.token;

  if (!isValidToken(token)) {
    return HtmlService.createHtmlOutput('<h2>Error: Invalid payment session.</h2>');
  }

  var cachedOrder = CacheService.getScriptCache().get('ORDER_' + token);
  if (!cachedOrder) {
    return HtmlService.createHtmlOutput('<h2>Error: Invalid or expired payment session.</h2>');
  }

  var orderData = JSON.parse(cachedOrder);
  var displayAmount = orderData.amount;
  var sessionKey = orderData.sessionKey;
  var scriptUrl = ScriptApp.getService().getUrl();

  var safeTokenHtml = escapeHtml(token);
  var safeAmountHtml = escapeHtml(displayAmount);
  var upiString = buildUpiLink(cfg, token, displayAmount);

  var html = '' +
    '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<title>Secure Checkout</title>' +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>' +
    '<style>' +
    'body{font-family:-apple-system,sans-serif;background:#000;color:#fff;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;}' +
    '.card{background:#111;padding:30px;border-radius:12px;box-shadow:0 4px 20px rgba(255,255,255,0.05);text-align:center;width:320px;border:1px solid #333;}' +
    'h2{margin:0 0 5px 0;color:#fff;} p{margin:0 0 20px 0;color:#aaa;}' +
    '#qrcode{display:flex;justify-content:center;margin:20px 0;padding:15px;background:#fff;border-radius:8px;}' +
    '.status{margin-top:15px;font-size:14px;font-weight:500;color:#888;}' +
    '.loader{color:#007bff;} .success{color:#28a745;font-size:16px;} .mismatch{color:#e0a800;font-size:15px;} .expired{color:#dc3545;font-size:15px;}' +
    '</style></head><body>' +
    '<div class="card">' +
    '<h2>Pay &#8377;' + safeAmountHtml + '</h2>' +
    '<p>' + escapeHtml(cfg.PAYEE_NAME) + '</p>' +
    '<div id="qrcode"></div>' +
    '<div id="status" class="status loader">Waiting for payment confirmation... &#8987;<br><br>' +
    '<small style="color:#555;">Order ID: ' + safeTokenHtml + '</small></div>' +
    '</div>' +
    '<script>' +
    'new QRCode(document.getElementById("qrcode"), { text: ' + toScriptLiteral(upiString) + ', width: 220, height: 220, colorDark: "#000", colorLight: "#fff" });' +
    'var WEB_APP_URL = ' + toScriptLiteral(scriptUrl) + ';' +
    'var TOKEN = ' + toScriptLiteral(token) + ';' +
    'var SESSION_KEY = ' + toScriptLiteral(sessionKey) + ';' +
    'var attempts = 0; var maxAttempts = 360;' + // ~30 min at 5s intervals
    'var checkInterval = setInterval(poll, 5000);' +
    'function poll() {' +
    '  attempts++;' +
    '  if (attempts > maxAttempts) { clearInterval(checkInterval); setState("expired", "Session timed out. Refresh to try again."); return; }' +
    '  fetch(WEB_APP_URL, {' +
    '    method: "POST",' +
    // text/plain keeps this a CORS "simple request" (irrelevant here
    // since it is same-origin, but harmless and future-proof).
    '    headers: { "Content-Type": "text/plain;charset=utf-8" },' +
    '    body: JSON.stringify({ action: "verify", token: TOKEN, session_key: SESSION_KEY })' +
    '  }).then(function(res){ return res.json(); }).then(function(data) {' +
    '    if (!data || !data.status) return;' +
    '    if (data.status === "success") {' +
    '      clearInterval(checkInterval);' +
    '      document.getElementById("qrcode").innerHTML = "";' +
    '      setState("success", "Payment verified. UTR: " + data.utr);' +
    '    } else if (data.status === "mismatch") {' +
    '      clearInterval(checkInterval);' +
    '      setState("mismatch", "Amount mismatch detected - contact support with your Order ID.");' +
    '    } else if (data.status === "expired") {' +
    '      clearInterval(checkInterval);' +
    '      setState("expired", "This payment session has expired.");' +
    '    }' +
    '  }).catch(function(){});' +
    '}' +
    'function setState(cls, text) {' +
    '  var el = document.getElementById("status");' +
    '  el.className = "status " + cls;' +
    '  el.textContent = text;' +
    '}' +
    '</script>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('Secure Checkout')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    // Restricts framing to reduce clickjacking risk (Apps Script only
    // offers DEFAULT or ALLOWALL - DEFAULT is the more restrictive one).
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// ==========================================
// ROUTE: VERIFY / POLL - the universal status-check call.
// Any client (Android, bot, custom web frontend) can call this directly
// with just the token+sessionKey it got back from createOrder. No
// secrets beyond those two, no crypto to implement - plain JSON in,
// plain JSON out, protected by HTTPS + possession of both values.
// ==========================================
function handleVerify(cfg, e) {
  var token = e.parameter.token;
  var sessionKey = e.parameter.session_key;

  if (!isValidToken(token)) return respond({ status: 'error', message: 'Missing or invalid token' });
  if (!sessionKey) return respond({ status: 'error', message: 'Missing session_key' });

  if (!checkRateLimit('verify_' + token, 30, 60)) {
    return respond({ status: 'error', message: 'Rate limit exceeded' });
  }

  return processVerification(cfg, token, sessionKey);
}

// ==========================================
// ROUTE: ADMIN STATUS LOOKUP (for support use)
// POST {"action":"status","admin_secret":"...","token":"..."} (recommended)
// or GET ?action=status&admin_secret=...&token=...
// ==========================================
function handleAdminStatus(cfg, e) {
  if (!checkRateLimit('admin_status_global', 30, 60)) {
    return respond({ status: 'error', message: 'Rate limit exceeded' });
  }
  if (!verifyAdminSecret(cfg, e)) {
    logSecurityEvent(cfg, 'unauthorized_admin_status', 'bad admin_secret', e.parameter.token || '');
    return respond({ status: 'error', message: 'UNAUTHORIZED' });
  }
  var token = e.parameter.token;
  if (!isValidToken(token)) return respond({ status: 'error', message: 'Invalid token' });

  var sheet = getDatabaseSheet(cfg);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === token) {
      return respond({
        status: 'found', token: token, timestamp: data[i][0], amount: data[i][2],
        ip: data[i][3], orderStatus: data[i][4], sender: data[i][5],
        utr: data[i][6], txnId: data[i][7]
      });
    }
  }
  return respond({ status: 'not_found' });
}

// ==========================================
// SMART DATA EXTRACTION ENGINE
// Adjust these patterns to match your bank's actual confirmation email.
// ==========================================
function smartExtract(rawBody) {
  var text = rawBody.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ');
  var data = { amount: 0, sender: 'Unknown', txnId: 'Not Found', utr: 'Not Found' };

  var amtMatch = text.match(/(?:₹|INR)\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (amtMatch) data.amount = parseFloat(amtMatch[1]);

  var txnMatch = text.match(/(FMPIB[A-Z0-9]+)/i);
  if (txnMatch) {
    data.txnId = txnMatch[1];
  } else {
    var backupTxn = text.match(/Transaction ID\s*:?\s*([A-Z0-9]+)/i);
    if (backupTxn) data.txnId = backupTxn[1].trim();
  }

  var fromMatch = text.match(/from\s+(.*?)(?=\s+at\s+\d|\s+with\s+|\s+Transaction|\s+FMPIB|$)/i);
  if (fromMatch) data.sender = fromMatch[1].trim();

  var utrMatch = text.match(/UTR\s*[:\-]?\s*([0-9]{6,})/i);
  data.utr = utrMatch ? utrMatch[1].trim() : data.txnId;

  return data;
}

function fetchConfirmationEmailBody(token) {
  var searchQuery = '"' + token + '" newer_than:1d';
  var threads = GmailApp.search(searchQuery, 0, 5);
  if (threads.length === 0) return null;

  var messages = threads[0].getMessages();
  for (var m = messages.length - 1; m >= 0; m--) {
    var body = messages[m].getPlainBody();
    if (body.toUpperCase().indexOf(token.toUpperCase()) !== -1) return body;
  }
  return messages[messages.length - 1].getPlainBody();
}

// Prevents one bank transaction (UTR) from being used to auto-complete
// more than one order - guards against a stray duplicate/forwarded email
// being matched against two different pending tokens.
function isDuplicateUtr(cfg, utr, excludeToken) {
  if (!utr || utr === 'Not Found') return false;
  var sheet = getDatabaseSheet(cfg);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === excludeToken) continue;
    if (String(data[i][4]).toUpperCase() === 'SUCCESS' && data[i][6] === utr) return true;
  }
  return false;
}

// ==========================================
// CORE LOGIC: Verification
// Returns plain JSON (no client-side decryption needed by design - see
// README section "Why there's no more encryption step").
// ==========================================
function processVerification(cfg, token, sessionKey) {
  var cache = CacheService.getScriptCache();
  var cachedOrder = cache.get('ORDER_' + token);
  if (!cachedOrder) return respond({ status: 'expired', token: token });

  var orderData = JSON.parse(cachedOrder);
  if (!safeEquals(String(sessionKey || ''), String(orderData.sessionKey || ''))) {
    logSecurityEvent(cfg, 'unauthorized_verify', 'bad session_key', token);
    return respond({ status: 'error', message: 'UNAUTHORIZED' });
  }

  var processedState = cache.get('STATE_' + token);
  if (processedState) return respond(JSON.parse(processedState));

  var sheet = getDatabaseSheet(cfg);
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][1] === token) {
      var rowStatus = String(data[i][4]).toUpperCase();
      if (rowStatus === 'SUCCESS') {
        var manualData = {
          status: 'success', token: token, expected: orderData.amount, paid: orderData.amount,
          sender: data[i][5] || 'Manual approval', utr: data[i][6] || 'Manual UTR',
          txnId: data[i][7] || 'Manual txn', isFraud: false
        };
        cache.put('STATE_' + token, JSON.stringify(manualData), 600);
        return respond(manualData);
      }
      if (rowStatus === 'MISMATCH' || rowStatus === 'DUPLICATE-UTR') {
        var mismatchData = { status: 'mismatch', token: token };
        cache.put('STATE_' + token, JSON.stringify(mismatchData), 600);
        return respond(mismatchData);
      }
      if (rowStatus === 'EXPIRED') {
        var expiredData = { status: 'expired', token: token };
        cache.put('STATE_' + token, JSON.stringify(expiredData), 600);
        return respond(expiredData);
      }
    }
  }

  var body = fetchConfirmationEmailBody(token);
  if (body) {
    var extracted = smartExtract(body);
    var isFraud = extracted.amount < orderData.amount;

    if (isDuplicateUtr(cfg, extracted.utr, token)) {
      updateOrderStatus(cfg, token, 'Duplicate-UTR', extracted.sender, extracted.utr, extracted.txnId);
      logSecurityEvent(cfg, 'duplicate_utr', extracted.utr, token);
      var dupResult = { status: 'mismatch', token: token };
      cache.put('STATE_' + token, JSON.stringify(dupResult), 600);
      return respond(dupResult);
    }

    if (isFraud) {
      updateOrderStatus(cfg, token, 'Mismatch', extracted.sender, extracted.utr, extracted.txnId);
      if (cfg.NOTIFY_ON_MISMATCH) notifyMerchant(cfg, 'Amount mismatch: ' + token,
        'Order ' + token + ' expected Rs.' + orderData.amount + ' but received Rs.' + extracted.amount + '.');
      var mismatchResult = { status: 'mismatch', token: token };
      cache.put('STATE_' + token, JSON.stringify(mismatchResult), 600);
      return respond(mismatchResult);
    }

    var successData = {
      status: 'success', token: token, expected: orderData.amount, paid: extracted.amount,
      sender: extracted.sender, utr: extracted.utr, txnId: extracted.txnId, isFraud: false
    };

    sendSecureWebhookOnce(cfg, successData);
    cache.put('STATE_' + token, JSON.stringify(successData), 600);
    updateOrderStatus(cfg, token, 'Success', successData.sender, successData.utr, successData.txnId);
    if (cfg.NOTIFY_ON_SUCCESS) notifyMerchant(cfg, 'Payment received: ' + token,
      'Order ' + token + ' for Rs.' + orderData.amount + ' confirmed.');

    return respond(successData);
  }

  return respond({ status: 'pending', token: token });
}

// ==========================================
// Signed webhook to your backend
// ==========================================

// Ensures the success webhook is only ever sent once per token, even if
// processVerification runs twice concurrently (e.g. sweeper and a live
// poll racing), and retries once on transient failure.
function sendSecureWebhookOnce(cfg, data) {
  var cache = CacheService.getScriptCache();
  var sentKey = 'WEBHOOK_SENT_' + data.token;
  if (cache.get(sentKey)) return;

  var delivered = sendSecureWebhook(cfg, data);
  if (!delivered) {
    Utilities.sleep(1000);
    delivered = sendSecureWebhook(cfg, data);
  }
  if (delivered) cache.put(sentKey, '1', 21600); // 6 hours (CacheService max)
  else logSecurityEvent(cfg, 'webhook_failed', data.token, JSON.stringify(data));
}

function sendSecureWebhook(cfg, data) {
  if (!cfg.WEBHOOK_URL) {
    console.error('WEBHOOK_URL script property not set - skipping webhook.');
    return false;
  }
  var payloadString = JSON.stringify(data);
  var signatureBytes = Utilities.computeHmacSha256Signature(payloadString, cfg.WEBHOOK_SECRET);
  var signatureHex = signatureBytes.map(function (byte) {
    var v = (byte < 0) ? 256 + byte : byte;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');

  try {
    var response = UrlFetchApp.fetch(cfg.WEBHOOK_URL, {
      method: 'post', contentType: 'application/json',
      headers: { 'X-Signature': signatureHex }, payload: payloadString, muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    return code >= 200 && code < 300;
  } catch (e) {
    console.error('Webhook delivery failed: ' + e.toString());
    return false;
  }
}

function notifyMerchant(cfg, subject, body) {
  if (!cfg.MERCHANT_EMAIL) return;
  try {
    MailApp.sendEmail(cfg.MERCHANT_EMAIL, subject, body);
  } catch (e) {
    console.error('notifyMerchant failed: ' + e.toString());
  }
}

function respond(data) {
  var output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

// ==========================================
// DATABASE: Google Sheets Logging
// ==========================================
function logInitialOrder(cfg, token, amount, ip) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var sheet = getDatabaseSheet(cfg);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Token', 'Amount (INR)', 'IP Address', 'Status', 'Sender Name', 'UTR', 'Transaction ID']);
      sheet.getRange('A1:H1').setFontWeight('bold');
    }
    sheet.appendRow([new Date(), token, amount, sanitizeForSheet(ip), 'Pending', '', '', '']);
  } finally {
    lock.releaseLock();
  }
}

function updateOrderStatus(cfg, token, status, sender, utr, txnId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    var sheet = getDatabaseSheet(cfg);
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] === token && String(data[i][4]).toUpperCase() === 'PENDING') {
        var rowIndex = i + 1;
        sheet.getRange(rowIndex, 5).setValue(status);
        sheet.getRange(rowIndex, 6).setValue(sanitizeForSheet(sender));
        sheet.getRange(rowIndex, 7).setValue(sanitizeForSheet(utr));
        sheet.getRange(rowIndex, 8).setValue(sanitizeForSheet(txnId));
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
}

// ==========================================
// ADMIN UTILITY: run manually (or on a monthly time trigger) to archive
// old rows out of the live sheet into a dated backup sheet, keeping the
// main sheet fast to scan as volume grows.
// ==========================================
function archiveOldOrders(daysOld) {
  var cfg = loadConfig();
  daysOld = daysOld || 30;
  var ss = SpreadsheetApp.openById(cfg.SHEET_ID);
  var sheet = getDatabaseSheet(cfg);
  var data = sheet.getDataRange().getValues();
  var cutoff = new Date(Date.now() - daysOld * 86400000);

  var archiveName = 'Archive_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  var archiveSheet = ss.getSheetByName(archiveName) || ss.insertSheet(archiveName);
  if (archiveSheet.getLastRow() === 0) archiveSheet.appendRow(data[0]);

  var rowsToDelete = [];
  for (var i = 1; i < data.length; i++) {
    var ts = new Date(data[i][0]);
    var status = String(data[i][4]).toUpperCase();
    if (ts < cutoff && status !== 'PENDING') {
      archiveSheet.appendRow(data[i]);
      rowsToDelete.push(i + 1);
    }
  }
  for (var d = rowsToDelete.length - 1; d >= 0; d--) {
    sheet.deleteRow(rowsToDelete[d]);
  }
  console.log('Archived ' + rowsToDelete.length + ' rows to ' + archiveName);
}
