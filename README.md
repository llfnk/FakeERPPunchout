# Merida PunchOut HU — Fake ERP

A stand-in for the buyer's procurement system (Ariba, SAP Business Network), to log into the Merida PunchOut HU catalog through a real PunchOut and get the cart back — without a real buyer's system.

One file, no dependencies, Node 22.9 or newer.

```bash
cp .env.example .env      # fill in a partner credential
npm start
# open http://lvh.me:8095
```

## What it does

1. **PunchOutSetupRequest.** Posts a cXML `PunchOutSetupRequest` to the backend: `POST /cxml/setup` (the shared URL, the credentials pick the partner) or `POST /cxml/setup/{partner uuid}`. It carries the From and Sender credentials with the `SharedSecret`, an optional DUNS as a second From credential, the operator (`UserEmail`, `UserFullName`), a fresh `BuyerCookie` and this tool's `/return` as the `BrowserFormPost` URL. The request goes from this server, not the browser, so the backend's CORS does not matter.
2. **StartPage.** Reads the `<StartPage>` URL from the `PunchOutSetupResponse` and opens the catalog on it — in an iframe on its page (like Ariba), in a new tab or in the same window. The page shows the request sent, with the `SharedSecret` masked, next to the raw answer, so a refusal (`401` for credentials, `400` for a malformed document) is visible as the backend wrote it.
3. **PunchOutOrderMessage.** The catalog posts the cart back to `/return` (`cxml-urlencoded` or `cxml-base64`). The tool shows its lines, the total and whether its `BuyerCookie` matches the setup; the list of setups links every setup to the cart it got back.

Every setting, the `SharedSecret` included, can be filled in or changed on the page between setups; the environment only gives the starting values.

## Why lvh.me

`lvh.me` resolves to 127.0.0.1 but is another site than `localhost` and than the catalog's own domain. The catalog in the iframe therefore runs truly cross-site, as it will in Ariba: its storage is partitioned and it gets no third-party cookies. Testing an iframe on two ports of one host proves nothing — that is still one site.

## Settings

`npm start` reads `.env` (git-ignored). Keep partner credentials there, or leave them out and fill them in on the page; `.env.example` lists every variable.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ERP_API_URL` | — | Backend origin; `http://localhost:8090` for the catalog repo's mock |
| `ERP_PARTNER_UUID` | empty | Post to `/cxml/setup/{uuid}` instead of the shared `/cxml/setup` |
| `ERP_DOMAIN` | `NetworkId` | Credential domain of From and Sender |
| `ERP_FROM` | — | From identity |
| `ERP_SENDER` | = From | Sender identity |
| `ERP_SHARED_SECRET` | — | The credential's SharedSecret (can also be filled in on the page) |
| `ERP_DUNS` | empty | Sent as a second From credential, domain `DUNS` |
| `ERP_TO` | — | To identity |
| `ERP_USER_EMAIL`, `ERP_USER_NAME` | test buyer | The operator the session records |
| `ERP_START_ORIGIN` | empty | Open the StartPage on another origin, e.g. `http://localhost:3001` to run a local catalog against the backend |
| `ERP_PORT` | `8095` | |
| `ERP_PUBLIC_URL` | `http://lvh.me:<port>` | This tool's own address, used for the `BrowserFormPost` URL |
| `ERP_BASIC_AUTH` | empty | `user:password` for HTTP Basic auth on every page but `/return` and `/health`; empty = no auth |

Use a partner credential with purpose `catalog` or `both` (backoffice: partner → credentials, where the SharedSecret can be revealed).

## Deploying (Coolify)

The repository has a `Dockerfile` (Node 22 Alpine, no dependencies, runs as `node`, `HEALTHCHECK` on `/health`).

1. New resource → the Git repository → build pack **Dockerfile**.
2. Ports exposes: `8095`; set the domain, e.g. `https://fake-erp.example.com`.
3. Environment variables: `ERP_PUBLIC_URL` = that domain (the catalog posts the cart back to `<ERP_PUBLIC_URL>/return`) and `ERP_BASIC_AUTH`. The partner credential (`ERP_FROM`, `ERP_SHARED_SECRET`, …) is optional there — it only prefills the form.

Always set `ERP_BASIC_AUTH` on a public deployment: whoever opens the page sees the `SharedSecret` in its form and can change the backend URL the setup posts it to. `/return` stays open so the catalog's form post always lands; `/health` stays open for the health check.

A public domain is its own site, so the iframe runs cross-site just as with `lvh.me`. History is still in memory (the last 200 setups) — a redeploy forgets it.

## Against the mock

The catalog repository (`MeridaPunchoutHUCatalog`) ships a mock of the backend that also answers `/cxml/setup`:

```bash
# in MeridaPunchoutHUCatalog
npm run mock:api
NUXT_PUBLIC_API_BASE_URL=http://localhost:8090 npm run dev -- --port 3001

# here
ERP_API_URL=http://localhost:8090 ERP_FROM=any ERP_SHARED_SECRET=any npm start
```

The mock accepts any credentials unless it runs with `MOCK_SHARED_SECRET`.

## What it is not

A test tool. The cXML it sends has the shape a procurement system's has, not every field Ariba or SAP send, and it keeps its history in memory only — a restart forgets it.
