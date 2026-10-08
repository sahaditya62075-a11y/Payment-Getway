<div align="center">

# 💸 UPI Payment Verification System

**Accept UPI payments with automatic verification — no payment gateway, no monthly fees.**
Built on Google Apps Script · Gmail · Google Sheets

![Platform](https://img.shields.io/badge/platform-Google%20Apps%20Script-4285F4?logo=google&logoColor=white)
![Payments](https://img.shields.io/badge/payments-UPI-5f259f)
![Clients](https://img.shields.io/badge/clients-Android%20%7C%20Web%20%7C%20Bots-brightgreen)
![Cost](https://img.shields.io/badge/server%20cost-%E2%82%B90-orange)

[Features](#-features) · [How it works](#-how-it-works) · [Setup](#-setup-guide) · [API](#-api-reference) · [Android](#-android-app-integration-kotlin) · [Web](#-web-integration) · [Bots](#-telegram--python-bot-integration) · [Buy](#-purchase--support)

</div>

---

## ✨ Features

- 🔐 **Secure by design** – separate secrets for order creation, admin lookup and webhooks; constant-time secret comparison; rate limiting on every sensitive route.
- 📱 **Universal client** – the same JSON API works from an Android app, a website, a Telegram/Discord bot, or any backend. No SDK, no client-side crypto.
- 🔗 **Ready-made UPI deep link** – every order returns a locked-amount `upi://pay` link you can launch directly.
- 🖥️ **Built-in checkout page** – a QR-code page that auto-polls and shows the result. Use it as-is or ignore it.
- 📧 **Gmail-based verification** – reads your bank's credit-alert email, extracts amount / sender / UTR / transaction ID and matches it to the order.
- 🧾 **Amount check** – an under-payment is flagged as `mismatch` instead of being approved.
- 🚫 **Duplicate-UTR protection** – one bank transaction can never complete two orders.
- 🪝 **Signed webhook** – success events are sent to your backend with an `X-Signature` HMAC-SHA256 header, delivered once, with one retry.
- ♻️ **Background sweeper** – recovers payments even if the customer closes the app/tab before confirmation.
- 📊 **Google Sheets database + audit log** – every order and every security event is recorded.
- 🛡️ **Injection-safe** – HTML escaping, safe script-literal embedding and spreadsheet formula-injection protection.
- ⚙️ **No redeploy for config changes** – settings live in Script Properties and are read on every request.

---

## 🧠 How it works

```
 ┌──────────────┐  1. createOrder (api_secret)   ┌─────────────────────┐
 │ YOUR BACKEND │ ─────────────────────────────▶ │  Apps Script        │
 │ (Node/PHP/   │ ◀───────────────────────────── │  Web App            │
 │  Python…)    │  token, sessionKey, upiLink    │                     │
 └──────┬───────┘                                │  ┌───────────────┐  │
        │ 2. give token + sessionKey + upiLink   │  │ Google Sheet  │  │
        ▼                                        │  └───────────────┘  │
 ┌──────────────┐  3. user pays via UPI app      │  ┌───────────────┐  │
 │ Android / Web│ ─────────────▶ Bank            │  │ Gmail (bank   │  │
 │ / Bot client │                                │  │ credit alert) │  │
 └──────┬───────┘  4. verify (token+sessionKey)  │  └───────────────┘  │
        │ ──────────────────────────────────────▶│                     │
        │ ◀──────────────────────────────────────│  5. match email →   │
        │  pending / success / mismatch / expired│     signed webhook  │
        └────────────────────────────────────────┴──────────┬──────────┘
                                                            ▼
                                                  YOUR BACKEND (webhook)
```

1. Your **backend** calls `createOrder` with the secret key and the amount.
2. You receive a `token`, a `sessionKey` and a ready-to-use `upiLink`. Hand these to the client.
3. The customer pays. The order token travels in the UPI `tr` (reference) field and the note, so it appears in the bank's alert email.
4. The client **polls** `verify` every few seconds.
5. The script finds the bank email containing the token, validates amount and UTR, updates the sheet, fires the signed webhook and returns `success`.

> ⚠️ **Important:** verification only works if your bank's credit-alert email **includes the UPI transaction note / reference** (which contains the order token). Make a ₹1 test payment first and check your email. See [Adapting to your bank](#-adapting-to-your-bank).

---

## 🚀 Setup guide

### 1. Prepare the Google Sheet
1. Create a new Google Sheet (any name).
2. Copy its ID from the URL: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`.
3. The header row is created automatically on the first order. A `Logs` tab is created automatically on the first security event.

> The script uses the **active (first) sheet** as the orders database. Keep the orders tab first.

### 2. Create the Apps Script project
1. Open <https://script.google.com> → **New project**.
2. Paste the full script into `Code.gs`.
3. Use the **same Google account** that receives your bank's UPI credit emails.

### 3. Set Script Properties
**Project Settings (⚙️) → Script Properties → Add script property**

| Property | Required | Description |
|---|:---:|---|
| `UPI_ID` | ✅ | Your UPI ID / VPA, e.g. `name@bank` |
| `PAYEE_NAME` | ✅ | Name shown to the payer in their UPI app |
| `API_CREATE_SECRET` | ✅ | Long random secret used by **your backend only** to create orders |
| `WEBHOOK_SECRET` | ✅ | Long random secret used to sign webhooks (HMAC-SHA256) |
| `WEBHOOK_URL` | ✅ | HTTPS endpoint on your backend that receives payment-success events |
| `SHEET_ID` | ✅ | ID of the Google Sheet from step 1 |
| `ADMIN_SECRET` | ✅ | Secret for the support/status lookup route |
| `MERCHANT_EMAIL` | ➖ | Where to send notification emails |
| `NOTIFY_ON_SUCCESS` | ➖ | `true` / `false` (default `false`) |
| `NOTIFY_ON_MISMATCH` | ➖ | `true` / `false` (default `true`) |
| `ORDER_EXPIRY_MINUTES` | ➖ | Minutes before a pending order is marked `Expired` (default `30`) |

Generate strong secrets, for example:

```bash
openssl rand -hex 32
```

### 4. Validate the configuration
In the editor choose the function **`checkConfig`** → **Run**. Approve the permission prompts (Gmail, Sheets, external requests, email). It reports any missing property and confirms the sheet is reachable.

### 5. Deploy as a Web App
1. **Deploy → New deployment → Web app**
2. **Execute as:** `Me`
3. **Who has access:** `Anyone`
4. Copy the **Web app URL** — this is your `BASE_URL` (ends in `/exec`).

Quick test:

```bash
curl "BASE_URL?action=ping"
# {"status":"ok","time":"2026-10-08T10:00:00.000Z"}
```

> After changing the **code**, create a **new version** (Deploy → Manage deployments → Edit → New version). Changing **Script Properties** needs no redeploy.

### 6. Add the time-driven triggers
**Triggers (⏰) → Add Trigger**

| Function | Event source | Suggested interval |
|---|---|---|
| `recoverLostPayments` | Time-driven → Minutes timer | Every 5 minutes |
| `expireOldOrders` | Time-driven → Hour timer | Every hour |
| `archiveOldOrders` | Time-driven → Month timer | Monthly *(optional)* |

---

## 📡 API reference

All routes live on the same URL. **POST with a JSON body is recommended** for anything that carries a secret (it keeps secrets out of URLs, browser history and server logs). GET is supported for quick testing.

| Action | Methods | Auth | Purpose |
|---|---|---|---|
| `ping` | GET | none | Health check |
| `createOrder` | GET / POST | `api_secret` | Create an order — **backend only** |
| `checkout` | GET | none (needs token) | Hosted QR checkout page |
| `verify` | GET / POST | `token` + `session_key` | Poll payment status — any client |
| `status` | GET / POST | `admin_secret` | Support lookup of an order |

### `createOrder` — backend only

```http
POST BASE_URL
Content-Type: application/json

{
  "action": "createOrder",
  "api_secret": "YOUR_API_CREATE_SECRET",
  "amount": 499,
  "ip": "203.0.113.7"
}
```

`ip` is optional (logged for audit and used for rate limiting — 10 orders/minute per IP). Amount must be > 0 and ≤ `1,000,000`.

```json
{
  "status": "success",
  "token": "A1B2C3D4E5F6",
  "sessionKey": "9f3a1c2e",
  "amount": 499,
  "upiLink": "upi://pay?pa=name%40bank&pn=Shop&am=499&cu=INR&tr=A1B2C3D4E5F6&tn=Order%20A1B2C3D4E5F6",
  "checkoutUrl": "https://script.google.com/macros/s/.../exec?action=checkout&token=A1B2C3D4E5F6",
  "webAppUrl": "https://script.google.com/macros/s/.../exec"
}
```

### `verify` — any client

```http
POST BASE_URL
Content-Type: text/plain;charset=utf-8

{"action":"verify","token":"A1B2C3D4E5F6","session_key":"9f3a1c2e"}
```

| `status` | Meaning | What your client should do |
|---|---|---|
| `pending` | No matching bank email yet | Keep polling (every ~5 s) |
| `success` | Payment confirmed | Show success, unlock the product |
| `mismatch` | Amount too low, or UTR already used | Stop polling, ask the user to contact support |
| `expired` | Session timed out | Stop polling, create a new order |
| `error` | Bad token / session key / rate limit | Check `message` |

Success payload:

```json
{
  "status": "success",
  "token": "A1B2C3D4E5F6",
  "expected": 499,
  "paid": 499,
  "sender": "RAHUL KUMAR",
  "utr": "412345678901",
  "txnId": "FMPIB1234567890",
  "isFraud": false
}
```

Rate limit: 30 `verify` calls per minute per token.

### `status` — admin / support

```bash
curl -X POST "BASE_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"status","admin_secret":"YOUR_ADMIN_SECRET","token":"A1B2C3D4E5F6"}'
```

Returns `found` (with timestamp, amount, ip, orderStatus, sender, utr, txnId) or `not_found`.

### Order statuses in the sheet

`Pending` → `Success` · `Mismatch` · `Duplicate-UTR` · `Expired`

You can also approve a payment manually: change the `Status` cell of a pending row to `Success` and the next `verify` call returns success.

---

## 🪝 Webhook (server → your backend)

On every confirmed payment the script POSTs to `WEBHOOK_URL`:

```http
POST https://your-backend.com/upi-webhook
Content-Type: application/json
X-Signature: <hex HMAC-SHA256 of the raw body using WEBHOOK_SECRET>

{"status":"success","token":"A1B2C3D4E5F6","expected":499,"paid":499,"sender":"RAHUL KUMAR","utr":"412345678901","txnId":"FMPIB1234567890","isFraud":false}
```

- Respond with any **2xx** status to acknowledge. Otherwise it retries once, then logs `webhook_failed`.
- Delivered **at most once** per order on success (deduplicated). Make your handler idempotent anyway.
- **Always verify the signature on the raw request body** before trusting it.

### Node.js / Express receiver

```js
const express = require('express');
const crypto = require('crypto');
const app = express();

// Keep the RAW body — the signature is computed over the exact bytes.
app.post('/upi-webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const expected = crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  const received = String(req.get('X-Signature') || '');
  const ok =
    received.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));

  if (!ok) return res.status(401).send('bad signature');

  const payment = JSON.parse(req.body.toString('utf8'));
  // TODO: mark order payment.token as PAID in your DB (idempotently)
  console.log('Paid:', payment.token, payment.paid, payment.utr);

  res.sendStatus(200);
});

app.listen(3000);
```

### Python / Flask receiver

```python
import hmac, hashlib, os, json
from flask import Flask, request, abort

app = Flask(__name__)
SECRET = os.environ["WEBHOOK_SECRET"].encode()

@app.post("/upi-webhook")
def upi_webhook():
    raw = request.get_data()  # raw bytes
    expected = hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, request.headers.get("X-Signature", "")):
        abort(401)
    payment = json.loads(raw)
    # TODO: mark payment["token"] as PAID (idempotently)
    return "", 200
```

---

## 📱 Android app integration (Kotlin)

> 🔒 **Never put `API_CREATE_SECRET` inside the APK.** The app asks **your backend** to create the order; your backend calls Apps Script and returns only `token`, `sessionKey` and `upiLink`.

### Flow

1. App → your backend: *"create order for ₹499"*.
2. Your backend → Apps Script `createOrder` → returns `token`, `sessionKey`, `upiLink`.
3. App launches `upiLink` with an `Intent.ACTION_VIEW` (the user picks GPay / PhonePe / Paytm…).
4. App polls `verify` until `success`, `mismatch` or `expired`.

### Dependencies (`build.gradle`)

```gradle
implementation "com.squareup.okhttp3:okhttp:4.12.0"
implementation "org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1"
```

### Launch the UPI app

```kotlin
fun startUpiPayment(activity: Activity, upiLink: String) {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(upiLink))
    val chooser = Intent.createChooser(intent, "Pay with")
    if (intent.resolveActivity(activity.packageManager) != null) {
        activity.startActivity(chooser)
    } else {
        Toast.makeText(activity, "No UPI app found", Toast.LENGTH_LONG).show()
    }
}
```

On Android 11+ add this to `AndroidManifest.xml` so `resolveActivity` can see UPI apps:

```xml
<queries>
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="upi" />
    </intent>
</queries>
```

### Poll for the result

```kotlin
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class UpiVerifier(private val webAppUrl: String) {

    private val client = OkHttpClient()   // follows Apps Script redirects by default

    suspend fun waitForPayment(
        token: String,
        sessionKey: String,
        timeoutMs: Long = 30 * 60 * 1000L,
        intervalMs: Long = 5_000L
    ): JSONObject = withContext(Dispatchers.IO) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val body = JSONObject()
                .put("action", "verify")
                .put("token", token)
                .put("session_key", sessionKey)
                .toString()
                .toRequestBody("text/plain;charset=utf-8".toMediaType())

            val request = Request.Builder().url(webAppUrl).post(body).build()
            try {
                client.newCall(request).execute().use { resp ->
                    val json = JSONObject(resp.body!!.string())
                    when (json.optString("status")) {
                        "success", "mismatch", "expired" -> return@withContext json
                        "error" -> return@withContext json
                    }
                }
            } catch (_: Exception) { /* network blip — try again */ }
            delay(intervalMs)
        }
        JSONObject().put("status", "expired")
    }
}
```

### Use it (e.g. in a ViewModel / Activity)

```kotlin
lifecycleScope.launch {
    val order = myBackend.createOrder(amount = 499)       // YOUR backend, not Apps Script directly
    startUpiPayment(this@PayActivity, order.upiLink)

    val result = UpiVerifier(order.webAppUrl).waitForPayment(order.token, order.sessionKey)
    when (result.optString("status")) {
        "success"  -> showSuccess(result.optString("utr"))
        "mismatch" -> showSupportMessage(order.token)
        else       -> showExpired()
    }
}
```

> 💡 **Always trust your backend, not the app.** Unlock the purchased item when your **webhook** fires. Treat the in-app result only as UI feedback.

---

## 🌐 Web integration

### Option A — Hosted checkout page (zero front-end code)

Your backend calls `createOrder` and redirects the customer to `checkoutUrl`:

```js
// Express example — YOUR backend
app.post('/pay', async (req, res) => {
  const r = await fetch(process.env.BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'createOrder',
      api_secret: process.env.API_CREATE_SECRET,
      amount: 499,
      ip: req.ip
    })
  });
  const order = await r.json();
  if (order.status !== 'success') return res.status(502).json(order);

  // save order.token against your own order ID, then:
  res.redirect(order.checkoutUrl);
});
```

The page shows a QR code, polls automatically and displays the UTR on success.

### Option B — Your own UI (QR + polling)

Backend returns `upiLink`, `token`, `sessionKey`, `webAppUrl` to your page. Then:

```html
<div id="qr"></div>
<a id="payBtn">Pay with UPI app</a>
<p id="status">Waiting for payment…</p>

<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
  async function startPayment() {
    const order = await (await fetch('/pay-json', { method: 'POST' })).json(); // your backend

    new QRCode(document.getElementById('qr'), { text: order.upiLink, width: 220, height: 220 });
    document.getElementById('payBtn').href = order.upiLink;   // opens UPI app on mobile

    const timer = setInterval(async () => {
      const res = await fetch(order.webAppUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // avoids CORS preflight
        body: JSON.stringify({ action: 'verify', token: order.token, session_key: order.sessionKey })
      });
      const data = await res.json();

      if (data.status === 'success')  { clearInterval(timer); status.textContent = 'Paid! UTR: ' + data.utr; }
      if (data.status === 'mismatch') { clearInterval(timer); status.textContent = 'Amount mismatch — contact support.'; }
      if (data.status === 'expired')  { clearInterval(timer); status.textContent = 'Session expired.'; }
    }, 5000);
  }
  startPayment();
</script>
```

> Use `Content-Type: text/plain` for browser calls. A `application/json` header triggers a CORS preflight that Apps Script does not answer.

---

## 🤖 Telegram / Python bot integration

Works with `python-telegram-bot`, `pyTelegramBotAPI`, `Pyrogram`, Discord bots, etc. Your bot process is a *backend*, so it may hold `API_CREATE_SECRET` — keep it in an environment variable, never in a public repo.

```python
import asyncio, os, aiohttp

BASE_URL = os.environ["UPI_BASE_URL"]            # Apps Script /exec URL
API_SECRET = os.environ["UPI_API_CREATE_SECRET"]

async def create_order(session, amount):
    async with session.post(BASE_URL, json={
        "action": "createOrder", "api_secret": API_SECRET, "amount": amount
    }) as r:
        return await r.json(content_type=None)

async def wait_for_payment(session, token, session_key, timeout=1800, every=5):
    waited = 0
    while waited < timeout:
        async with session.post(BASE_URL, data=__import__("json").dumps(
            {"action": "verify", "token": token, "session_key": session_key}
        ), headers={"Content-Type": "text/plain;charset=utf-8"}) as r:
            data = await r.json(content_type=None)
        if data.get("status") in ("success", "mismatch", "expired", "error"):
            return data
        await asyncio.sleep(every)
        waited += every
    return {"status": "expired"}

# --- inside your /buy handler ---
async def handle_buy(message):
    async with aiohttp.ClientSession() as s:
        order = await create_order(s, amount=99)
        if order.get("status") != "success":
            return await message.reply("Could not create order, try later.")

        await message.reply(
            f"Pay ₹{order['amount']} using this link:\n{order['checkoutUrl']}\n\n"
            "I'll confirm automatically once the payment arrives."
        )
        result = await wait_for_payment(s, order["token"], order["sessionKey"])
        if result["status"] == "success":
            await message.reply(f"✅ Payment received! UTR: {result['utr']}")
        elif result["status"] == "mismatch":
            await message.reply("⚠️ Amount mismatch. Contact support with your order ID: " + order["token"])
        else:
            await message.reply("⌛ Order expired. Please try again.")
```

For production, prefer the **webhook** to grant access (more reliable than a long-running poll per user).

---

## 🏦 Adapting to your bank

Banks word their credit emails differently. Edit **`smartExtract()`** to match yours:

| Field | Current pattern |
|---|---|
| Amount | `₹` or `INR` followed by digits |
| Transaction ID | `FMPIB…` (or `Transaction ID: …` fallback) |
| Sender | text after `from` |
| UTR | `UTR: 123456…` (falls back to the transaction ID) |

Checklist:
1. Make a small real payment and open the alert email.
2. Confirm the **order token** appears in the email body (UPI note / reference).
3. Adjust the regexes above until `amount`, `sender`, `utr` extract correctly.
4. Make sure the alert email is not auto-filed somewhere Gmail search can't see (inbox/labels are fine, Trash/Spam are not).

---

## 🔒 Security notes

- **Secrets stay server-side.** `API_CREATE_SECRET` must never be in an Android app, a browser, or a public repo. Only `token` + `sessionKey` go to clients.
- **`token` + `sessionKey` together** authorise polling for that one order. Treat them as short-lived.
- **Always confirm payments via the signed webhook** (or by your backend calling `verify`/`status`) before delivering goods — never trust a client-side "success".
- **Verify the webhook signature** on the raw body, use constant-time comparison, and make the handler idempotent.
- **Use POST** for secret-bearing calls. GET puts secrets into URLs and logs.
- **Rotate secrets** if they leak (edit Script Properties — takes effect immediately).
- The amount check flags **under-payment**; an over-payment is accepted as success. Adjust `processVerification` if you need exact-match.
- Order sessions live in CacheService for **30 minutes**; `ORDER_EXPIRY_MINUTES` controls when the sweeper marks sheet rows as `Expired`.
- Review the `Logs` sheet for `unauthorized_*`, `rate_limited`, `duplicate_utr` and `webhook_failed` events.

---

## 📈 Limits & quotas

Apps Script has daily quotas that apply to your Google account type (consumer vs Workspace). The ones that matter most here are Gmail reads, `UrlFetch` calls (webhooks), email sends, trigger runtime, and 6-minute max execution per run. Quotas change over time — check Google's official page: <https://developers.google.com/apps-script/guides/services/quotas>

Tips to stay inside them:
- Poll every **5 seconds or slower**.
- Keep `NOTIFY_ON_SUCCESS` off if you have high volume.
- Run `archiveOldOrders` monthly so the sheet stays fast.

---

## 🧰 Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Missing Script Properties: …` | Run `checkConfig`, add the listed properties |
| `UNAUTHORIZED` on createOrder | Wrong `api_secret` |
| `UNAUTHORIZED` on verify | `session_key` doesn't match the one returned by `createOrder` |
| Always `pending` | Bank email not received / token not in the email / wrong Gmail account / regex doesn't match |
| `expired` immediately | Session older than 30 min, or order not created |
| `mismatch` | Paid less than ordered, or the same UTR was already used |
| Webhook never arrives | Check `Logs` for `webhook_failed`; endpoint must return 2xx over HTTPS |
| Browser CORS error | Send `Content-Type: text/plain;charset=utf-8` |
| Changes not live | You edited code — publish a **new version** of the deployment |
| Rate limit exceeded | Slow down polling / order creation |

---

## 🛒 Purchase & Support

Want the **ready-to-deploy script**, **one-to-one setup help**, **bank-email pattern tuning**, or a **custom integration** (Android, website, Telegram bot)?

<div align="center">

### 👨‍💻 Developer: ᏢᴀɢᴀᏞ ϻ❿ ×͜ak

[![Telegram](https://img.shields.io/badge/Telegram-Contact%20Developer-26A5E4?logo=telegram&logoColor=white&style=for-the-badge)](https://t.me/i_m_pagal)

**👉 [t.me/i_m_pagal](https://t.me/i_m_pagal)**

</div>

| What you get | Details |
|---|---|
| 📦 Full source | Complete, commented Apps Script code |
| 🛠️ Setup assistance | Properties, deployment, triggers, webhook |
| 🔧 Customisation | Bank email patterns, your own checkout design, extra routes |
| 📱 Integrations | Android (Kotlin), Web, Telegram / Discord bots |

Message the developer on Telegram with your use case (Android / Web / Bot) and expected volume for pricing and delivery details.

---

## ⚠️ Disclaimer

This project verifies payments by reading bank notification emails. It is **not** an official payment-gateway or NPCI product. Test thoroughly with small real payments before going live, keep your own reconciliation against bank statements, and comply with the laws and bank terms that apply to your business.

---

<div align="center">

Made with ❤️ by **ᏢᴀɢᴀᏞ ϻ❿ ×͜ak** · [t.me/i_m_pagal](https://t.me/i_m_pagal)

⭐ Star the repo if it helped you!

</div>
