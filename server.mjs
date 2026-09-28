#!/usr/bin/env node
/**
 * Merida PunchOut HU — fake ERP. A stand-in for the buyer's procurement system (Ariba, SAP), to log
 * into the Merida catalog through a real PunchOut, the way a buyer does:
 *
 *   1. posts a cXML PunchOutSetupRequest to the backend (POST /cxml/setup or /cxml/setup/{partner});
 *   2. reads the StartPage URL from the PunchOutSetupResponse and opens the catalog on it — in an
 *      iframe on this page (cross-site, like Ariba) or in a new tab;
 *   3. receives the cart back: the catalog posts the PunchOutOrderMessage to /return.
 *
 *   npm start                          # then open http://lvh.me:8095
 *
 * Settings come from the environment (npm start reads .env). See README.md for every ERP_* variable.
 * The SharedSecret is never written into the page: the request shown there has it masked.
 */
import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

const PORT = Number(process.env.ERP_PORT ?? 8095)
const PUBLIC_URL = process.env.ERP_PUBLIC_URL ?? `http://lvh.me:${PORT}`

/** The last settings used; the secret stays here and never goes into a page. */
const settings = {
  apiUrl: process.env.ERP_API_URL ?? '',
  partnerUuid: process.env.ERP_PARTNER_UUID ?? '',
  domain: process.env.ERP_DOMAIN ?? 'NetworkId',
  from: process.env.ERP_FROM ?? '',
  sender: process.env.ERP_SENDER ?? '',
  duns: process.env.ERP_DUNS ?? '',
  to: process.env.ERP_TO ?? '',
  secret: process.env.ERP_SHARED_SECRET ?? '',
  userEmail: process.env.ERP_USER_EMAIL ?? 'buyer.user@example.com',
  userName: process.env.ERP_USER_NAME ?? 'Test Buyer',
  operation: 'create',
  startOrigin: process.env.ERP_START_ORIGIN ?? '',
  open: 'iframe',
}

/** Setups sent, newest first: what was asked, what came back, and the cart returned for it. */
const history = []

// ---------- cXML ----------

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const html = esc

function setupRequest(s, buyerCookie) {
  const credential = (domain, identity, secret) =>
    `<Credential domain="${esc(domain)}"><Identity>${esc(identity)}</Identity>${secret === undefined ? '' : `<SharedSecret>${esc(secret)}</SharedSecret>`}</Credential>`
  const froms = [credential(s.domain, s.from), ...(s.duns ? [credential('DUNS', s.duns)] : [])].join('\n      ')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE cXML SYSTEM "http://xml.cxml.org/schemas/cXML/1.2.014/cXML.dtd">
<cXML payloadID="${Date.now()}.${randomBytes(6).toString('hex')}@fake-erp.local" timestamp="${new Date().toISOString()}" xml:lang="en-US">
  <Header>
    <From>
      ${froms}
    </From>
    <To>
      ${credential('NetworkId', s.to)}
    </To>
    <Sender>
      ${credential(s.domain, s.sender || s.from, s.secret)}
      <UserAgent>Merida fake ERP</UserAgent>
    </Sender>
  </Header>
  <Request deploymentMode="test">
    <PunchOutSetupRequest operation="${esc(s.operation)}">
      <BuyerCookie>${esc(buyerCookie)}</BuyerCookie>
      <Extrinsic name="UserEmail">${esc(s.userEmail)}</Extrinsic>
      <Extrinsic name="UniqueName">${esc(s.userEmail)}</Extrinsic>
      <Extrinsic name="UserFullName">${esc(s.userName)}</Extrinsic>
      <BrowserFormPost><URL>${esc(`${PUBLIC_URL}/return`)}</URL></BrowserFormPost>
      <Contact role="endUser">
        <Name xml:lang="en">${esc(s.userName)}</Name>
        <Email>${esc(s.userEmail)}</Email>
      </Contact>
      <SupplierSetup><URL>${esc(setupUrl(s))}</URL></SupplierSetup>
    </PunchOutSetupRequest>
  </Request>
</cXML>`
}

function setupUrl(s) {
  const base = s.apiUrl.replace(/\/+$/, '')
  return s.partnerUuid ? `${base}/cxml/setup/${encodeURIComponent(s.partnerUuid)}` : `${base}/cxml/setup`
}

const tag = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1]?.trim()
const attr = (xml, name, attribute) => xml.match(new RegExp(`<${name}\\b[^>]*\\b${attribute}="([^"]*)"`))?.[1]
const unescapeXml = text => String(text ?? '').replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e])

/** The PunchOutOrderMessage's lines, for a table. */
function orderLines(xml) {
  return [...xml.matchAll(/<ItemIn\b([^>]*)>([\s\S]*?)<\/ItemIn>/g)].map(([, attrs, body]) => ({
    quantity: attrs.match(/quantity="([^"]*)"/)?.[1] ?? '',
    sku: unescapeXml(tag(body, 'SupplierPartID')),
    description: unescapeXml(tag(body, 'Description')),
    price: tag(tag(body, 'UnitPrice') ?? '', 'Money') ?? '',
    currency: attr(body, 'Money', 'currency') ?? '',
    unit: unescapeXml(tag(body, 'UnitOfMeasure')),
  }))
}

// ---------- pages ----------

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${html(title)}</title>
<style>
  :root { color-scheme: light; font: 14px system-ui, sans-serif; color: #1d2733; }
  body { margin: 0; background: #eef1f5; }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #1d3b5f; color: #fff; }
  header strong { margin-right: auto; }
  header a { color: #fff; }
  main { padding: 16px; display: grid; gap: 16px; }
  section { background: #fff; border-radius: 8px; padding: 16px; }
  h2 { margin: 0 0 12px; font-size: 15px; }
  form.settings { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px 16px; }
  label { display: grid; gap: 4px; font-size: 12px; color: #4a5a6b; }
  input, select { font: inherit; padding: 6px 8px; border: 1px solid #c8d1db; border-radius: 4px; }
  .actions { grid-column: 1 / -1; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  button, a.button { font: inherit; padding: 8px 14px; border: 0; border-radius: 4px; background: #f0b429; color: #1d2733; cursor: pointer; text-decoration: none; font-weight: 600; }
  button.secondary { background: #dde3ea; font-weight: 400; }
  .hint { font-size: 12px; color: #6b7a8a; }
  .ok { color: #1a7f37; font-weight: 600; } .bad { color: #b42318; font-weight: 600; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; background: #f6f8fa; padding: 12px; border-radius: 6px; font-size: 12px; max-height: 360px; overflow: auto; }
  details { margin-top: 8px; } summary { cursor: pointer; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e3e8ee; } td.num { text-align: right; font-variant-numeric: tabular-nums; }
  iframe { display: block; width: 100%; height: 80vh; border: 1px solid #c8d1db; border-radius: 6px; background: #fff; }
</style></head><body>${body}</body></html>`

function settingsForm() {
  const s = settings
  const field = (name, label, value, extra = '') => `<label>${html(label)}<input name="${name}" value="${html(value)}" ${extra}></label>`
  const secretState = s.secret ? 'set — leave empty to keep it' : 'not set'
  return `<form class="settings" method="post" action="/setup">
    ${field('apiUrl', 'Backend (API origin)', s.apiUrl, 'required')}
    ${field('partnerUuid', 'Partner uuid — empty = shared /cxml/setup', s.partnerUuid)}
    ${field('domain', 'Credential domain', s.domain)}
    ${field('from', 'From identity', s.from, 'required')}
    ${field('sender', 'Sender identity — empty = From', s.sender)}
    ${field('duns', 'DUNS (optional, sent as a second From credential)', s.duns)}
    ${field('to', 'To identity', s.to, 'required')}
    <label>SharedSecret (${secretState})<input name="secret" type="password" autocomplete="off" placeholder="${s.secret ? '••••••••' : 'or set ERP_SHARED_SECRET'}"></label>
    ${field('userEmail', 'Operator e-mail (UserEmail)', s.userEmail)}
    ${field('userName', 'Operator name (UserFullName)', s.userName)}
    <label>Operation<select name="operation">${['create', 'edit', 'inspect'].map(o => `<option${o === s.operation ? ' selected' : ''}>${o}</option>`).join('')}</select></label>
    ${field('startOrigin', 'Open the StartPage on another origin (optional)', s.startOrigin, 'placeholder="e.g. http://localhost:3001"')}
    <label>Open the catalog<select name="open">${[['iframe', 'in an iframe on this page (like Ariba)'], ['tab', 'in a new tab'], ['window', 'in this window']].map(([v, t]) => `<option value="${v}"${v === s.open ? ' selected' : ''}>${t}</option>`).join('')}</select></label>
    <div class="actions">
      <button type="submit">Send PunchOutSetupRequest</button>
      <span class="hint">Goes to <code>${html(setupUrl(s))}</code>; the cart comes back to <code>${html(PUBLIC_URL)}/return</code>.</span>
    </div>
  </form>`
}

function historySection() {
  if (!history.length) return ''
  const rows = history.map(h => `<tr>
      <td>${html(h.at.slice(11, 19))}</td>
      <td class="${h.status === '200' ? 'ok' : 'bad'}">${html(h.status ?? h.error ?? '—')} ${html(h.statusText ?? '')}</td>
      <td><code>${html(h.buyerCookie)}</code></td>
      <td>${h.startPage ? `<a href="${html(h.startPage)}" target="_blank" rel="noopener">StartPage</a>` : '—'}</td>
      <td>${h.returned ? `<a href="/order/${html(h.buyerCookie)}">cart returned ${html(h.returned.at.slice(11, 19))}</a>` : '—'}</td>
    </tr>`).join('')
  return `<section><h2>Setups this run</h2><table><thead><tr><th>At</th><th>Status</th><th>BuyerCookie</th><th>Catalog</th><th>Cart</th></tr></thead><tbody>${rows}</tbody></table></section>`
}

function exchangeDetails(h) {
  return `<details><summary>PunchOutSetupRequest sent (SharedSecret masked)</summary><pre>${html(h.request)}</pre></details>
    <details${h.status === '200' ? '' : ' open'}><summary>Answer (HTTP ${html(h.httpStatus ?? '—')})</summary><pre>${html(h.response ?? h.error ?? '')}</pre></details>`
}

function homePage(latest) {
  let result = ''
  if (latest) {
    const opened = latest.startPage && settings.open === 'iframe'
      ? `<iframe title="Merida catalog" src="${html(latest.startPage)}"></iframe>`
      : ''
    const openNow = latest.startPage && settings.open !== 'iframe'
      ? `<script>${settings.open === 'tab' ? `window.open(${JSON.stringify(latest.startPage)}, '_blank')` : `location.href = ${JSON.stringify(latest.startPage)}`}</script>
         <p><a class="button" href="${html(latest.startPage)}" target="${settings.open === 'tab' ? '_blank' : '_self'}" rel="noopener">Open the catalog</a> <span class="hint">if the browser blocked the new tab</span></p>`
      : ''
    result = `<section>
      <h2>Answer: <span class="${latest.status === '200' ? 'ok' : 'bad'}">${html(latest.status ?? latest.error ?? '—')} ${html(latest.statusText ?? '')}</span></h2>
      ${latest.startPage ? `<p>StartPage: <code>${html(latest.startPage)}</code>${latest.rewrittenFrom ? ` <span class="hint">(the backend answered ${html(latest.rewrittenFrom)})</span>` : ''}</p>` : ''}
      ${openNow}
      ${exchangeDetails(latest)}
    </section>
    ${opened ? `<section><h2>Merida catalog — BuyerCookie <code>${html(latest.buyerCookie)}</code></h2>${opened}</section>` : ''}`
  }
  return page('Fake ERP', `<header><strong>Fake ERP — PunchOut to Merida</strong><a href="/">new setup</a></header>
    <main>
      <section><h2>PunchOutSetupRequest</h2>${settingsForm()}</section>
      ${result}
      ${historySection()}
    </main>`)
}

function orderPage(h) {
  const r = h.returned
  const lines = orderLines(r.xml)
  const total = tag(tag(r.xml, 'Total') ?? '', 'Money')
  const cookie = unescapeXml(tag(r.xml, 'BuyerCookie'))
  const rows = lines.map(l => `<tr><td><code>${html(l.sku)}</code></td><td>${html(l.description)}</td><td class="num">${html(l.quantity)}</td><td>${html(l.unit)}</td><td class="num">${html(l.price)} ${html(l.currency)}</td></tr>`).join('')
  return page('Fake ERP — cart received', `<header><strong>Fake ERP — cart received</strong><a href="/">new setup</a></header>
    <main><section>
      <h2>PunchOutOrderMessage</h2>
      <p>Received ${html(r.at)} in field <code>${html(r.field)}</code>, posted to the top window.
        BuyerCookie <code>${html(cookie)}</code> ${cookie === h.buyerCookie ? '<span class="ok">matches the setup</span>' : `<span class="bad">does not match the setup (${html(h.buyerCookie)})</span>`}.</p>
      <table><thead><tr><th>SKU</th><th>Description</th><th>Qty</th><th>Unit</th><th>Unit price (net)</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No ItemIn lines</td></tr>'}</tbody></table>
      <p>Total (net): <strong>${html(total ?? '—')}</strong></p>
      <details open><summary>cXML</summary><pre>${html(r.xml)}</pre></details>
    </section>${historySection()}</main>`)
}

// ---------- server ----------

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw
}

function send(res, status, body, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(body)
}

async function runSetup(form) {
  for (const key of Object.keys(settings)) {
    if (key === 'secret') continue
    if (form.has(key)) settings[key] = form.get(key).trim()
  }
  const secret = form.get('secret')
  if (secret) settings.secret = secret

  const buyerCookie = `FAKE-ERP-${randomUUID()}`
  const xml = setupRequest(settings, buyerCookie)
  const entry = {
    at: new Date().toISOString(),
    buyerCookie,
    request: settings.secret ? xml.replace(`<SharedSecret>${esc(settings.secret)}</SharedSecret>`, '<SharedSecret>••••••••</SharedSecret>') : xml,
  }
  history.unshift(entry)

  try {
    const answer = await fetch(setupUrl(settings), { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body: xml, signal: AbortSignal.timeout(20_000) })
    entry.httpStatus = answer.status
    entry.response = await answer.text()
    entry.status = attr(entry.response, 'Status', 'code') ?? String(answer.status)
    entry.statusText = attr(entry.response, 'Status', 'text') ?? ''
    const url = unescapeXml(tag(tag(entry.response, 'StartPage') ?? '', 'URL') ?? '')
    if (url) {
      entry.startPage = url
      if (settings.startOrigin) {
        const original = new URL(url)
        entry.startPage = new URL(original.pathname + original.search + original.hash, settings.startOrigin).toString()
        entry.rewrittenFrom = url
      }
    }
  } catch (error) {
    entry.error = `${error.name}: ${error.cause?.message ?? error.message}`
  }
  return entry
}

createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL)
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, homePage(null))

    if (req.method === 'POST' && url.pathname === '/setup') {
      const entry = await runSetup(new URLSearchParams(await readBody(req)))
      return send(res, 200, homePage(entry))
    }

    // The catalog posts the cart here (BrowserFormPost), target="_top"
    if (req.method === 'POST' && url.pathname === '/return') {
      const form = new URLSearchParams(await readBody(req))
      const field = form.has('cxml-base64') ? 'cxml-base64' : 'cxml-urlencoded'
      const raw = form.get(field) ?? ''
      const xml = field === 'cxml-base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw
      const cookie = unescapeXml(tag(xml, 'BuyerCookie'))
      let entry = history.find(h => h.buyerCookie === cookie)
      if (!entry) {
        entry = { at: new Date().toISOString(), buyerCookie: cookie || '(none)', request: '', status: '—', statusText: 'setup not from this run' }
        history.unshift(entry)
      }
      entry.returned = { at: new Date().toISOString(), field, xml }
      res.writeHead(303, { Location: `/order/${encodeURIComponent(entry.buyerCookie)}` })
      return res.end()
    }

    const order = url.pathname.match(/^\/order\/(.+)$/)
    if (req.method === 'GET' && order) {
      const entry = history.find(h => h.buyerCookie === decodeURIComponent(order[1]) && h.returned)
      return entry ? send(res, 200, orderPage(entry)) : send(res, 404, page('Not found', '<main><section>No cart for this BuyerCookie.</section></main>'))
    }

    send(res, 404, page('Not found', '<main><section>Not found. <a href="/">Back</a></section></main>'))
  } catch (error) {
    send(res, 500, page('Error', `<main><section><pre>${html(error.stack)}</pre></section></main>`))
  }
}).listen(PORT, () => {
  console.log(`fake ERP on ${PUBLIC_URL} — setup goes to ${setupUrl(settings)}${settings.secret ? '' : ' (no ERP_SHARED_SECRET yet)'}`)
})
