# PearsonAssist

Voice guide for **Pearson Packaging Systems** visitors and customers. Built on official OpenAI GPT-Live WebRTC (`client.live.create`), with research delegated to a Responses backend that may only search **pearsonpkg.com**.

Framing: **PearsonAssist · Pearson Packaging Systems** — automated packaging solutions voice guide.

## Guardrails

- The only allowed information source is `https://pearsonpkg.com` (and subdomains).
- `web_search` is configured with `filters.allowed_domains: ["pearsonpkg.com"]`.
- The browser drops any `present_link_cards` URL whose hostname is not `pearsonpkg.com` or `*.pearsonpkg.com`.
- If the site does not cover a question, PearsonAssist says so and suggests contacting Pearson at +1 (509) 838-6226 or browsing pearsonpkg.com.
- Never invents specs, pricing, or capabilities.

## Branding

Colors and fonts follow the official Pearson brand sheet:

| Role | Token | Hex |
| --- | --- | --- |
| Primary orange | `--orange` | `#e54102` |
| Primary gray | `--gray` | `#5f5f5f` |
| Primary blurple | `--blurple` | `#343551` |
| Dusty blue | `--dusty-blue` | `#6790a0` |
| Sage | `--sage` | `#90a997` |
| Dark navy | `--dark-navy` | `#0c2949` |
| Red-orange | `--red-orange` | `#e04426` |
| Charcoal | `--charcoal` | `#4c4b4c` |
| Silver | `--silver` | `#bebebe` |
| Forest | `--forest` | `#42725e` |

- Titles/headers: **Montserrat**
- Body: **Roboto**
- Primary brand mark: circular orange P logo in `public/media/pearson-logo.png` (topbar + hero)
- Wordmark/reverse assets retained: `pearson-logo.webp`, `pearson-logo-rev.webp`, `favicon.png`

## Requirements

- Node.js **20+**
- An OpenAI project API key with **GPT-Live** access
- A browser with microphone permission

## Setup

```bash
cd pearson-assist
npm install
cp .env.example .env
# Edit .env and set OPENAI_API_KEY=sk-...
npm start
```

Open [http://localhost:3000](http://localhost:3000), press **Ask PearsonAssist**, allow the microphone, and ask about Pearson equipment, industries, service, or parts.

```bash
npm run dev
```

## Deploy on Vercel

- Static UI from `public/`
- Serverless `POST /api/session` (`api/session.js`)

| Variable | Notes |
| --- | --- |
| `OPENAI_API_KEY` | Encrypted / sensitive. Required for Live sessions. |
| `RESPONSES_MODEL` | Optional. Default `gpt-5.6-terra`. |

Production URL: https://pearson-assist.vercel.app

## Architecture

Same GPT-Live WebRTC + Responses delegation pattern as the voice-news-live demo, with Pearson-only search filters and industrial B2B UI.

## Author

Scott Reed ([smreed32](https://github.com/smreed32))
