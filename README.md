# eufy HomeBase 2 bulk downloader

Download all the recorded clips from a **eufy HomeBase 2 (T8010)** to MP4 files in one go, instead of
saving them one at a time in the eufy app.

- Talks to the HomeBase directly over your local network (P2P), so it can see everything stored on it
- Saves each clip as `eufy_videos/<camera>/<camera>_<date>_<time>.mp4`
- Re-runnable: clips you already have are skipped, so you can stop and resume
- Your eufy login stays on your own computer

> Not affiliated with eufy or Anker. Unofficial, use at your own risk, and only on your own devices.

## Requirements

- **Node.js 24.5 or newer** — `node -v`
- **ffmpeg** on your PATH — `ffmpeg -version` (without it you get raw `.h264` / `.aac` files instead of `.mp4`)
- A computer on the **same network** as the HomeBase
- The eufy account that **owns** the HomeBase

### Installing them

**Windows 11** (PowerShell):

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
```

Then open a **new** terminal. If `ffmpeg` still isn't recognised, run:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
```

**macOS**: `brew install node ffmpeg` · **Debian/Ubuntu**: install Node 24+ from [nodejs.org](https://nodejs.org), then `sudo apt install ffmpeg`

## Setup

```bash
git clone https://github.com/<your-username>/eufy-homebase2-downloader.git
cd eufy-homebase2-downloader
npm install
```

(Or download the ZIP from GitHub, unzip it, open a terminal in that folder and run `npm install`.)

## Usage

**Windows (PowerShell):**

```powershell
$env:EUFY_USERNAME="you@example.com"
$env:EUFY_PASSWORD = Read-Host "eufy password"
$env:EUFY_COUNTRY="GB"
npm start
```

**macOS / Linux:**

```bash
export EUFY_USERNAME="you@example.com"
read -rs -p "eufy password: " EUFY_PASSWORD && export EUFY_PASSWORD
export EUFY_COUNTRY="GB"
npm start
```

The first time, eufy emails you a verification code — type it when asked. The login is then saved in
`eufy_v6_session.json`, so later runs don't ask again.

### Options (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `EUFY_USERNAME` | — | eufy account email (required) |
| `EUFY_PASSWORD` | — | eufy account password (required) |
| `EUFY_COUNTRY` | `GB` | Two-letter country your eufy account is registered in (`US`, `DE`, …) |
| `DAYS_BACK` | `3` | How many days of recordings to fetch |
| `OUT_DIR` | `./eufy_videos` | Where to save clips |
| `DEBUG` | off | Set to `1` to write a detailed log to `eufy_debug.log` |
| `EXTRA_BASES` | — | Experimental: other base models to try, e.g. `T8020` (see below) |

Example — everything from the last 30 days: `DAYS_BACK=30 npm start` (PowerShell: `$env:DAYS_BACK="30"; npm start`)

### Example output

```
HomeBase: Home (T8010XXXXXXXXXXX) - connecting...
Connected.
  Listing recordings... 562 found

Camera: Front Yard - 562 clip(s) in the last 3 days
    2026-11-16_23-12-51 ... done (12s)
    2026-11-16_23-11-39 ... done (9s)
```

## Important

- **Your phone app may get logged out.** eufy tends to allow one active session per account. Just log back in.
- **Use the account that owns the HomeBase.** Shared/guest accounts are untested and may not be given the
  decryption keys.
- **Keep `eufy_v6_session.json` private.** It's a live login to your eufy account. It's in `.gitignore`;
  delete it when you're done if you like.
- **24/7 continuous recordings** are not covered — only event clips.
- **Video doorbells on their own base (T8020) are not supported yet** — see below.

## Troubleshooting

| Problem | Fix |
|---|---|
| `ffmpeg is not recognized` | Open a new terminal, or run the PATH refresh command above |
| `npm : running scripts is disabled` (Windows) | Use `npm.cmd install` / `npm.cmd start` |
| Login error / wrong password | Use the exact email + password you use in the eufy app, and the right `EUFY_COUNTRY` |
| `key-unavailable` | Run `npm run keycheck` and open an issue with the RESULTS block (it prints no secrets) |
| First 5 clips fail and it stops | Open an issue with the output; run again with `DEBUG=1` for more detail |
| `0 clip(s)` | Check the app shows clips for that period; try a larger `DAYS_BACK` |

## How it works

1. Logs in to eufy's current (v6) cloud, which is the only place the clip decryption keys are served from now.
2. Opens a P2P session to the HomeBase and reads its own recording table (`history_record_info`), paging
   from newest to oldest using a time cursor.
3. For each clip, fetches the decryption key and streams the recording from the HomeBase.
4. Muxes the video (H.264/H.265) and audio (AAC) into an MP4 with ffmpeg — no re-encoding.

Two HomeBase 2 quirks this handles:

- The recording table is paged with `start_time` as a **cursor** (`"0"` = newest, then the oldest row's
  `yyyyMMddHHmmss`). Sending the start date there, as older libraries do, returns nothing.
- Each clip's `cipher_id` carries a flag in its high bits (e.g. `134217815` = `0x08000000` + `87`). eufy's
  cloud only knows the low part (`87`), so the flag is stripped before asking for the key.

## Doorbell base (T8020) — not supported yet

A eufy video doorbell paired with its own T8020 base (not the HomeBase 2) gets as far as listing and
transferring clips, but they can't be decoded. Findings, in case you can take it further
(`EXTRA_BASES=T8020 npm start` runs the experimental path):

- Recordings live at `/media/mmcblk0p1/Camera00/h264_<yyyyMMddHHmmss>.dat` and list through the same
  `history_record_info` query as the HomeBase 2.
- Every clip has `cipher_id: 1`. Neither the v3 nor the legacy v2 `get_ciphers` endpoint returns cipher 1
  (they only return the account's HomeBase 2 key).
- It uses eufy's older scheme: only keyframes are sealed, laid out as
  `[22-byte header][128-byte RSA-wrapped AES key][1 byte][first 128 bytes AES-ECB][rest in clear]`;
  other frames and AAC audio are in the clear. The account's RSA key does not unwrap it.
- Asking the base to re-wrap the clip with a client-supplied RSA key (`CMD_SET_PAYLOAD` → `CMD_DOWNLOAD_VIDEO`
  with `key`) is refused with `-103` (invalid command).

The experimental code decodes this scheme with any RSA key eufy returns, so if someone finds where
cipher 1 comes from, it should only need that key. PRs welcome.

## Tested with

- HomeBase 2 (T8010) with T8113 cameras, Windows 11, Node 26 — working
- T8020 doorbell base with a T8222 doorbell — lists and transfers, but can't decrypt (see above)

Other cameras on a HomeBase 2 will probably work. HomeBase 3 and standalone cameras are not supported by
this tool (the underlying SDK supports some of them).

## Credits

- [`@mega-yfue/eufy-sdk`](https://github.com/mega-yfue/eufy-sdk) (Apache-2.0) does the heavy lifting: v6
  login, P2P and recording decryption.
- [`eufy-security-client`](https://github.com/bropat/eufy-security-client) by bropat, whose protocol work
  everything here builds on.

## License

MIT — see [LICENSE](LICENSE).
