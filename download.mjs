#!/usr/bin/env node
/**
 * Bulk-download recorded clips from a eufy HomeBase 2 (T8010).
 *
 * Uses @mega-yfue/eufy-sdk, which speaks eufy's current (v6) cloud. That matters because
 * HomeBase 2 recordings are encrypted, and the key to unlock them now only comes from the
 * v6 cloud - the older library couldn't get it ("Cannot convert undefined or null to object").
 *
 * Re-runnable: clips already on disk are skipped.
 *
 * Usage: see README.md
 *   npm install
 *   EUFY_USERNAME=you@example.com EUFY_PASSWORD=... npm start
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import {
    EufyMega, FileSessionStore, LoginStatus, CommandType, AccessUnitAssembler, STATION_CHUNK_BYTES,
} from "@mega-yfue/eufy-sdk";

// ---------------------------------------------------------------- CONFIG ----
const CONFIG = {
    username: process.env.EUFY_USERNAME,
    password: process.env.EUFY_PASSWORD,
    country: process.env.EUFY_COUNTRY || "GB",
    outDir: process.env.OUT_DIR || path.resolve("eufy_videos"),
    daysBack: parseInt(process.env.DAYS_BACK || "3", 10),
    clipTimeoutMs: 180000,
};
// ----------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const ymdhms = (d) => `${ymd(d)}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const stamp = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "camera";

function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}

/** "2026-11-16 23:12:51" (HomeBase local time) -> Date */
function parseStationTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s));
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function hasFfmpeg() {
    const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return !r.error && r.status === 0;
}

function fileLogger(file) {
    const w = (lvl) => (msg, ...args) =>
        fs.appendFileSync(file, `${new Date().toISOString()} ${lvl} ${msg} ${args.length ? JSON.stringify(args).slice(0, 2000) : ""}\n`);
    return { debug: w("DEBUG"), info: w("INFO"), warn: w("WARN"), error: w("ERROR") };
}

// ------------------------------------------------------------------ LOGIN ---
async function login(eufy) {
    let r = await eufy.login();
    for (let i = 0; i < 6 && r.status !== LoginStatus.Ok; i++) {
        if (r.status === LoginStatus.Captcha) {
            const file = path.resolve("eufy_captcha.png");
            fs.writeFileSync(file, Buffer.from(String(r.image).replace(/^data:image\/\w+;base64,/, ""), "base64"));
            const answer = await ask(`${r.retry ? "Wrong, try again. " : ""}Captcha: open ${file} and type the characters: `);
            r = await eufy.solveCaptcha(answer);
        } else if (r.status === LoginStatus.TwoFactor) {
            r = await eufy.submitVerifyCode(await ask("eufy sent you a verification code. Enter it: "));
        }
    }
    if (r.status !== LoginStatus.Ok) throw new Error("Login did not complete");
}

// ------------------------------------------------------------ LISTING ---
/** Every recording on the HomeBase since `since`, newest first. Pages newest -> oldest by time cursor. */
async function listRecordings(session, accountId, since) {
    const clips = new Map();
    let cursor = "0";
    let stale = 0;
    for (let page = 0; page < 500; page++) {
        const groups = await session.queryRecordPage({
            accountId,
            count: 20,
            startDate: ymd(since),
            endDate: ymd(new Date()),
            startTime: cursor,
        });
        const rows = [];
        for (const g of groups || []) {
            if (Array.isArray(g?.payload)) {
                if (!g.table_name || g.table_name === "history_record_info") rows.push(...g.payload);
            } else if (g?.storage_path) rows.push(g);
        }
        let oldest = null;
        let added = 0;
        for (const r of rows) {
            const t = parseStationTime(r.start_time);
            if (!t) continue;
            if (!oldest || t < oldest) oldest = t;
            if (!r.storage_path || t < since) continue;
            const key = r.record_id ?? `${r.storage_path}|${r.start_time}`;
            if (clips.has(key)) continue;
            clips.set(key, { deviceSn: r.device_sn, storagePath: r.storage_path, cipherId: r.cipher_id, start: t });
            added++;
        }
        process.stdout.write(`\r  Listing recordings... ${clips.size} found`);
        if (!rows.length || !oldest || oldest < since) break;
        if (added === 0) {
            if (++stale >= 3) break;
            oldest = new Date(oldest.getTime() - 1000);
        } else stale = 0;
        cursor = ymdhms(oldest);
        await sleep(300);
    }
    process.stdout.write("\n");
    return [...clips.values()].sort((a, b) => b.start - a.start);
}

// ----------------------------------------------------------- SAVING ---
function saveClip(rec, finalPath, ffmpegOk) {
    const isHevc = rec.codec === "h265";
    const base = finalPath.replace(/\.mp4$/, "");
    const vFile = `${base}.${isHevc ? "h265" : "h264"}`;
    const aFile = `${base}.aac`;
    fs.writeFileSync(vFile, rec.video);
    const hasAudio = rec.audio && rec.audio.length > 0;
    if (hasAudio) fs.writeFileSync(aFile, rec.audio);
    if (!ffmpegOk) return vFile;

    const fps = String(rec.fps && isFinite(rec.fps) && rec.fps > 0 ? Math.round(rec.fps) : 15);
    const args = ["-hide_banner", "-loglevel", "error", "-y",
        "-framerate", fps, "-f", isHevc ? "hevc" : "h264", "-i", vFile];
    if (hasAudio) args.push("-f", "aac", "-i", aFile);
    args.push("-map", "0:v");
    if (hasAudio) args.push("-map", "1:a", "-bsf:a", "aac_adtstoasc");
    args.push("-c", "copy");
    if (isHevc) args.push("-tag:v", "hvc1");
    args.push("-movflags", "+faststart", finalPath);
    const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
    if (r.status !== 0) {
        fs.rmSync(finalPath, { force: true }); // don't leave an empty .mp4 that a re-run would skip
        throw new Error(`ffmpeg failed, raw files kept: ${(r.stderr || "").trim().split("\n").pop()}`);
    }
    fs.rmSync(vFile, { force: true });
    if (hasAudio) fs.rmSync(aFile, { force: true });
    return finalPath;
}

// ------------------------------------------------ EXTRA BASE MODELS ---
// EXPERIMENTAL, off by default: other bases to try, e.g. EXTRA_BASES=T8020 (the base a eufy video
// doorbell pairs with). Listing and transfer work on the T8020, but its clips are locked with a key
// (cipher_id 1) that eufy's cloud doesn't hand out - see README "Doorbell base (T8020)".
const HB2_LIKE = new Set((process.env.EXTRA_BASES || "").split(",").map((s) => s.trim()).filter(Boolean));

/**
 * Recording settings for bases the SDK doesn't list, borrowed from its HomeBase 2 settings.
 * `sealed` = clips are encrypted and need a key from eufy's cloud; `clear` = read them as-is.
 * These bases name files differently (e.g. Camera00/h264_20261116215302.dat), which the SDK's
 * HomeBase 2 name check rejects - so the station's own full path is passed straight through.
 */
function extraBaseEntries(eufy) {
    const router = eufy.p2p;
    const proto = router && Object.getPrototypeOf(router);
    if (!proto || typeof proto.recordingStationFor !== "function" || typeof router.downloadRecording !== "function") return null;
    const fake = {
        recordFor: (sn) => (sn === "__cam" ? { sn: "__cam", stationSn: "__base", raw: {} } : { sn: "__base", model: "T8010", raw: {} }),
    };
    const hb2 = proto.recordingStationFor.call(fake, "__cam");
    if (!hb2) return null;
    const path = (channel, rec) => (/^\/media\/mmcblk0p1\/[\w./-]+\.dat$/.test(rec) ? rec : hb2.path(channel, rec));
    return { sealed: { ...hb2, path }, clear: { ...hb2, path, sealed: false } };
}

// ------------------------------------------- DOORBELL BASE (RSA) CLIPS ---
// The T8020 doorbell base uses eufy's older clip encryption: each keyframe's data starts with a
// 128-byte RSA-wrapped AES key (+1 byte), followed by the frame with its first 128 bytes AES-ECB
// encrypted. Other frames are not encrypted. Its clips list cipher_id 1, which eufy's cloud doesn't know - so we try the RSA
// keys the cloud does hand out for this account and keep whichever yields a valid H.264 keyframe.
const FRAME_HEADER = 22;
const WRAPPED_KEY = 129; // 128-byte RSA block + 1 byte

let NodeRSA;
function toRsa(pem) {
    const body = String(pem).replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
    const der = Buffer.from(body, "base64");
    for (const fmt of ["pkcs8-private-der", "pkcs1-private-der"]) {
        try {
            const k = new NodeRSA();
            k.importKey(der, fmt);
            k.setOptions({ encryptionScheme: "pkcs1", environment: "browser" });
            return k;
        } catch { /* try next format */ }
    }
    return null;
}

async function loadRsaKeys(eufy, ids, accountId, stationSns) {
    if (!NodeRSA) {
        try { ({ default: NodeRSA } = await import("node-rsa")); } catch {
            throw new Error('missing package "node-rsa" - run: npm install node-rsa');
        }
    }
    const keys = [];
    for (const id of ids) {
        for (const sn of stationSns) {
            if (keys.some((k) => k.id === id)) break;
            try {
                const res = await eufy.api.getCiphers([id], accountId, sn);
                for (const c of Array.isArray(res) ? res : []) {
                    if (!c.private_key || keys.some((k) => k.id === Number(c.cipher_id))) continue;
                    const rsa = toRsa(c.private_key);
                    if (rsa) keys.push({ id: Number(c.cipher_id), rsa });
                }
            } catch { /* try the next one */ }
            await sleep(500);
        }
    }
    return keys;
}

const beginsUnit = (b) => b.length >= 4 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1));

function aesEcb(key, data) {
    const n = data.length - (data.length % 16);
    const d = crypto.createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data.subarray(0, n)), d.final(), data.subarray(n)]);
}

/** Payload extractor for AccessUnitAssembler: unwraps RSA-sealed frames, passes clear ones through. */
function rsaFrameDecoder(keys, state) {
    const aesCache = new Map();
    return (payload) => {
        const len = payload.readUInt32LE(0);
        const clear = payload.subarray(FRAME_HEADER, FRAME_HEADER + len);
        // Sealed = a keyframe whose data doesn't start with a NAL start code. The wrapped key sits
        // inside the declared length: [header 22][wrapped key 128][1 byte][AES-ECB 128][clear rest].
        if ((payload[4] & 1) !== 1 || len < WRAPPED_KEY + 128 || beginsUnit(clear)) return clear;
        const wrapped = payload.subarray(FRAME_HEADER, FRAME_HEADER + 128);
        const start = FRAME_HEADER + WRAPPED_KEY;
        const enc = payload.subarray(start, start + 128);
        const rest = payload.subarray(start + 128, FRAME_HEADER + len);
        const order = state.key ? [state.key, ...keys.filter((k) => k !== state.key)] : keys;
        for (const k of order) {
            const tag = `${k.id}|${wrapped.toString("base64")}`;
            let aes = aesCache.get(tag);
            if (!aes) {
                try { aes = k.rsa.decrypt(wrapped); } catch { continue; }
                if (![16, 24, 32].includes(aes.length)) continue;
                aesCache.set(tag, aes);
            }
            const body = Buffer.concat([aesEcb(aes, enc), rest]);
            if (beginsUnit(body) || state.key === k) { state.key = k; return body; }
        }
        return undefined;
    };
}

/** Download one clip from a doorbell base: let the SDK run the transfer, decode the frames ourselves. */
async function downloadRsaClip(eufy, entry, session, camSn, channel, recPath, keys, state, timeoutMs) {
    const frames = [];
    const onData = (f) => {
        if (f.channel !== channel || f.dataType !== 3) return;
        if (f.commandId !== CommandType.CMD_VIDEO_FRAME && f.commandId !== CommandType.CMD_AUDIO_FRAME) return;
        frames.push({ commandId: f.commandId, raw: Buffer.from(f.raw) });
    };
    session.on("data", onData);
    let sdk;
    try {
        sdk = await eufy.p2p.downloadRecording(camSn, entry, { recording: recPath, timeoutMs });
    } catch (e) {
        if (e.reason !== "undecodable") throw e; // the SDK can't decode these itself - that's expected
    } finally {
        session.off("data", onData);
    }
    const decode = rsaFrameDecoder(keys, state);
    const asm = new AccessUnitAssembler(undefined, STATION_CHUNK_BYTES);
    const video = [];
    const audio = [];
    let keyframes = 0;
    let fpsHeader;
    for (const f of frames) {
        if (f.commandId === CommandType.CMD_VIDEO_FRAME) {
            fpsHeader ??= f.raw.readUInt16LE(8);
            for (const u of asm.push(f.raw, decode)) {
                video.push(u.data);
                if (u.keyframe) keyframes++;
            }
        } else if (f.raw[5] === 0) {
            audio.push(f.raw.subarray(16)); // AAC, not encrypted on this base
        }
    }
    if (!frames.length) throw new Error("the base sent no frames");
    if (!keyframes) {
        throw new Error(`keyframes could not be decrypted (${keys.length} key(s) tried: ${keys.map((k) => k.id).join(",") || "none"})`);
    }
    return {
        video: Buffer.concat(video),
        audio: sdk?.audio?.length ? sdk.audio : audio.length ? Buffer.concat(audio) : undefined,
        codec: /h265/i.test(recPath) ? "h265" : "h264",
        fps: sdk?.fps || fpsHeader || 15,
        durationMs: sdk?.durationMs ?? 0,
        keyframes,
    };
}

// --------------------------------------------------------------- MAIN ---
async function main() {
    if (!CONFIG.username || !CONFIG.password) {
        console.error("Set EUFY_USERNAME and EUFY_PASSWORD first.");
        process.exit(1);
    }
    const ffmpegOk = hasFfmpeg();
    if (!ffmpegOk) console.warn("ffmpeg not found - saving raw .h264/.aac files instead of .mp4.");

    const eufy = new EufyMega({
        email: CONFIG.username,
        password: CONFIG.password,
        countryCode: CONFIG.country,
        store: new FileSessionStore(path.resolve("eufy_v6_session.json")), // keeps you logged in between runs
        autoRealtime: false, // no push/MQTT - just what we need
        logger: process.env.DEBUG ? fileLogger(path.resolve("eufy_debug.log")) : undefined,
    });
    eufy.on("error", () => {}); // background transport noise; real failures surface below
    const extra = extraBaseEntries(eufy);
    const extraBasesOk = !!extra;

    process.on("SIGINT", async () => { console.log("\nStopping..."); try { await eufy.disconnect(); } catch {} process.exit(130); });

    console.log("Logging in to eufy...");
    await login(eufy);
    console.log("Logged in.");

    const devices = await eufy.getDevices();
    const bases = devices
        .filter((d) => d.model === "T8010" || (extraBasesOk && HB2_LIKE.has(d.model)))
        .sort((a, b) => (a.model === "T8010" ? 0 : 1) - (b.model === "T8010" ? 0 : 1)); // HomeBase 2 first
    const knownCipherIds = new Set(); // keys seen on HomeBase 2 clips - doorbell bases reuse the account's key
    const hb2Sns = bases.filter((b) => b.model === "T8010").map((b) => b.sn);
    if (!bases.length) throw new Error("No HomeBase 2 (T8010) found on this account.");

    let ok = 0, skipped = 0, failed = 0;
    const failures = [];
    const since = new Date(Date.now() - CONFIG.daysBack * 86400000);

    for (const hb of bases) {
        const label = hb.model === "T8010" ? "HomeBase" : `Base ${hb.model} (experimental)`;
        console.log(`\n${label}: ${hb.name || hb.sn} (${hb.sn}) - connecting...`);
        await eufy.connectStation(hb.sn);
        const session = eufy.getP2pSessions().get(hb.sn);
        if (!session) throw new Error("Connected, but no P2P session was opened.");
        const { accountId } = await eufy.stationReadTarget("list", hb.sn);
        console.log("Connected.");

        const recs = await listRecordings(session, accountId, since);
        const maskCipher = (id) => (Number(id) > 0xffffff ? Number(id) & 0x7ffffff : Number(id));
        if (hb.model === "T8010") for (const r of recs) if (r.cipherId !== undefined) knownCipherIds.add(maskCipher(r.cipherId));
        let rsaKeys = null;
        const rsaState = {};
        const cams = devices.filter((d) => d.sn !== hb.sn && d.stationSn === hb.sn);
        const nameOf = (sn) => cams.find((c) => c.sn === sn)?.name || sn;

        const bySn = new Map();
        for (const r of recs) {
            if (!bySn.has(r.deviceSn)) bySn.set(r.deviceSn, []);
            bySn.get(r.deviceSn).push(r);
        }
        for (const cam of cams) if (!bySn.has(cam.sn)) bySn.set(cam.sn, []);

        for (const [camSn, list] of bySn) {
            const camName = safe(nameOf(camSn));
            console.log(`\nCamera: ${nameOf(camSn)} - ${list.length} clip(s) in the last ${CONFIG.daysBack} days`);
            if (!list.length) continue;

            const dev = await eufy.getDevice(camSn);
            const onExtraBase = hb.model !== "T8010";
            if (onExtraBase && !rsaKeys) {
                const ids = [...new Set([...list.map((r) => maskCipher(r.cipherId)), ...knownCipherIds])];
                rsaKeys = await loadRsaKeys(eufy, ids, accountId, [hb.sn, ...hb2Sns]);
                console.log(`  Older-style encryption: trying ${rsaKeys.length} key(s) from eufy (${rsaKeys.map((k) => "#" + k.id).join(", ") || "none"})`);
            }
            const download = onExtraBase
                ? (opts) => downloadRsaClip(eufy, extra.clear, session, camSn, dev.channel ?? 0, opts.recording, rsaKeys, rsaState, opts.timeoutMs)
                : dev.camera?.()?.downloadRecording;
            if (typeof download !== "function") {
                console.log("  The SDK doesn't offer recording download for this camera - skipping.");
                failed += list.length;
                failures.push(`${camName}: download not available (model ${dev.model ?? "?"})`);
                continue;
            }
            const camDir = path.join(CONFIG.outDir, camName);
            fs.mkdirSync(camDir, { recursive: true });

            for (const r of list) {
                const finalPath = path.join(camDir, `${camName}_${stamp(r.start)}.mp4`);
                const base = finalPath.replace(/\.mp4$/, "");
                if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) { skipped++; continue; }
                if (!ffmpegOk && [`${base}.h264`, `${base}.h265`].some((p) => fs.existsSync(p))) { skipped++; continue; }

                // HomeBase 2: the SDK builds the path from the clip name. Other bases: pass the full path.
                const recording = hb.model === "T8010" ? path.basename(r.storagePath).replace(/\.[^.]+$/, "") : r.storagePath;
                process.stdout.write(`    ${stamp(r.start)} ... `);
                try {
                    // The HomeBase stores the cipher id with a flag in the high bits (e.g. 134217815 = flag + 87);
                    // eufy's cloud only knows the low part, so strip the flag.
                    const cipherId = Number(r.cipherId) > 0xffffff ? Number(r.cipherId) & 0x7ffffff : Number(r.cipherId);
                    const rec = await download({ recording, cipherId, timeoutMs: CONFIG.clipTimeoutMs });
                    if (onExtraBase && ok === 0 && rsaState.key) process.stdout.write(`(key #${rsaState.key.id} works) `);
                    saveClip(rec, finalPath, ffmpegOk);
                    ok++;
                    console.log(`done (${Math.round(rec.durationMs / 1000)}s)`);
                } catch (e) {
                    failed++;
                    const why = e.reason ? `${e.reason}: ${e.message}` : e.message;
                    failures.push(`${camName} ${stamp(r.start)} [${r.storagePath}]: ${why}`);
                    console.log(`FAILED (${why})`);
                    if (failed === 1) console.log(`      (station path was: ${r.storagePath})`);
                    if (failed >= 5 && ok === 0) {
                        console.log("\nFirst 5 clips all failed - stopping so we can look at why.");
                        return finish();
                    }
                    await sleep(2000);
                }
            }
        }
    }
    return finish();

    async function finish() {
        console.log(`\nFinished. Downloaded: ${ok}  Already had: ${skipped}  Failed: ${failed}`);
        if (failures.length) {
            fs.mkdirSync(CONFIG.outDir, { recursive: true });
            const f = path.join(CONFIG.outDir, "failed.txt");
            fs.writeFileSync(f, failures.join("\n") + "\n");
            console.log(`Failures listed in ${f}`);
        }
        console.log(`Videos saved to: ${CONFIG.outDir}`);
        try { await eufy.disconnect(); } catch {}
        process.exit(0);
    }
}

main().catch((e) => {
    console.error("\nError:", e?.message || e);
    if (e?.code !== undefined) console.error("eufy code:", e.code);
    process.exit(1);
});
