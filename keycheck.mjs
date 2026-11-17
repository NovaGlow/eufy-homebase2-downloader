#!/usr/bin/env node
/**
 * Read-only check: why can't the decryption key for HomeBase 2 clips be fetched?
 * Reuses the saved login from download.mjs. Prints no keys, tokens or passwords.
 *   npm run keycheck
 * Paste the RESULTS block into a GitHub issue if downloads fail with key-unavailable.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const out = [];
const log = (s) => out.push(s);
const ask = (q) => new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
});
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

function describe(ciphers) {
    if (!Array.isArray(ciphers)) return `not a list: ${typeof ciphers} ${JSON.stringify(ciphers)?.slice(0, 150)}`;
    if (!ciphers.length) return "empty list []";
    return ciphers.map((c) => `{cipher_id:${c.cipher_id}, fields:[${Object.keys(c).join(",")}]` +
        `, ecc_key:${c.ecc_private_key ? "present" : "MISSING"}, rsa_key:${c.private_key ? "present" : "MISSING"}}`).join(" ");
}

async function main() {
    if (!process.env.EUFY_USERNAME || !process.env.EUFY_PASSWORD) {
        console.error("Set EUFY_USERNAME and EUFY_PASSWORD first.");
        process.exit(1);
    }
    const errors = [];
    const eufy = new EufyMega({
        email: process.env.EUFY_USERNAME,
        password: process.env.EUFY_PASSWORD,
        countryCode: process.env.EUFY_COUNTRY || "GB",
        store: new FileSessionStore(path.resolve("eufy_v6_session.json")),
        autoRealtime: false,
    });
    eufy.on("error", (e) => errors.push(`${e?.message ?? e}${e?.code !== undefined ? ` (code ${e.code})` : ""}`));

    let r = await eufy.login();
    while (r.status !== LoginStatus.Ok) {
        if (r.status === LoginStatus.TwoFactor) r = await eufy.submitVerifyCode(await ask("Verification code: "));
        else if (r.status === LoginStatus.Captcha) {
            fs.writeFileSync("eufy_captcha.png", Buffer.from(String(r.image).replace(/^data:image\/\w+;base64,/, ""), "base64"));
            r = await eufy.solveCaptcha(await ask("Captcha (see eufy_captcha.png): "));
        }
    }
    console.log("Logged in. Checking (about a minute)...");

    const devices = await eufy.getDevices();
    const hb = devices.find((d) => d.model === "T8010");
    if (!hb) throw new Error("No HomeBase 2 found");
    log(`HomeBase: ${hb.sn}`);
    let loggedInId; try { loggedInId = eufy.api.gtokenUserId(); } catch { loggedInId = eufy.api.auth_?.accountUserId ?? eufy.api.auth_?.userId; }
    const raw = hb.raw || {};
    const adminId = raw.member?.admin_user_id;
    log(`Station member: admin_user_id=${adminId ? "set" : "MISSING"}  member_type=${raw.member?.member_type}  same_as_logged_in=${adminId && loggedInId ? adminId === loggedInId : "?"}`);

    await eufy.connectStation(hb.sn);
    const session = eufy.getP2pSessions().get(hb.sn);
    const { accountId } = await eufy.stationReadTarget("check", hb.sn);
    log(`P2P: connected=${session?.isConnected}  gatewayCipherId=${session?.gatewayCipherId}  level2Key=${session?.level2Key ? "yes" : "no"}`);

    const since = new Date(Date.now() - 3 * 86400000);
    const groups = await session.queryRecordPage({ accountId, count: 20, startDate: ymd(since), endDate: ymd(new Date()), startTime: "0" });
    const rows = groups.flatMap((g) => (Array.isArray(g?.payload) ? g.payload : [g])).filter((x) => x?.storage_path);
    const ids = [...new Set(rows.map((x) => Number(x.cipher_id)))];
    log(`Recent clips: ${rows.length}, cipher ids used: ${ids.join(", ")}`);
    if (rows[0]) log(`Sample row fields: ${Object.keys(rows[0]).join(",")}`);

    const tryIds = new Set();
    for (const id of ids) { tryIds.add(id); tryIds.add(id & 0xffff); tryIds.add(id & 0xffffff); tryIds.add(id % 134217728); }
    if (session?.gatewayCipherId !== undefined) tryIds.add(Number(session.gatewayCipherId));

    log("\n-- get_ciphers attempts --");
    for (const id of tryIds) {
        for (const [label, uid] of [["admin id", accountId], ["logged-in id", loggedInId]]) {
            if (!uid) continue;
            try {
                const res = await eufy.api.getCiphers([id], uid, hb.sn);
                log(`  id ${id} as ${label}: ${describe(res)}`);
            } catch (e) {
                log(`  id ${id} as ${label}: ERROR ${e.message}${e.code !== undefined ? ` (code ${e.code})` : ""}`);
            }
            await new Promise((s) => setTimeout(s, 1500));
            if (uid === loggedInId && label === "admin id") break;
        }
    }

    log("\n-- background errors --");
    log(errors.length ? [...new Set(errors)].slice(0, 15).map((e) => "  " + e).join("\n") : "  (none)");

    console.log("\n===== RESULTS =====\n" + out.join("\n") + "\n===== END =====");
    fs.writeFileSync("eufy_keycheck.txt", out.join("\n") + "\n");
    try { await eufy.disconnect(); } catch {}
    process.exit(0);
}

main().catch((e) => { console.error("Error:", e?.message || e); process.exit(1); });
