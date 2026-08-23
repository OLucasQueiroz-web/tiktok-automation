#!/usr/bin/env node
/**
 * Teste isolado: detectar a idade do vídeo (tv_post_time) em N vídeos do feed.
 *
 * Abre o TikTok, navega ao perfil, entra no primeiro vídeo e percorre N vídeos
 * via swipe (igual ao open-tiktok), pausando cada um e tentando ler tv_post_time.
 *
 * Uso: node test-age-detection.js [quantidade]   (padrão: 5)
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !(m[1].trim() in process.env)) process.env[m[1].trim()] = m[2].trim();
  });
} catch {}

const TIKTOK_PACKAGE  = "com.zhiliaoapp.musically";
const SEARCH_QUERY    = "felipyoms1g";
const UNLOCK_PIN      = process.env.TIKTOK_PIN || "";
const OUT_DIR         = path.join(__dirname, "ui-analysis");
const TEST_COUNT      = parseInt(process.argv[2] || "5", 10);
const AGE_MAX_RETRIES = 5;
const AGE_INTERVAL    = 700;

fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Primitivos ───────────────────────────────────────────────────────────────

function adb(...args) {
  const r = spawnSync("adb", args, { encoding: "utf8" });
  if (r.error) throw r.error;
  return r.stdout.trim();
}

function sleep(ms) { execSync(`sleep ${ms / 1000}`); }

function wakeScreen() {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  sleep(300);
}

function isLocked() {
  const out = adb("shell", "dumpsys", "window");
  return out.includes("mDreamingLockscreen=true") ||
         out.includes("isStatusBarKeyguard=true") ||
         out.includes("mShowingLockscreen=true");
}

function unlockIfNeeded() {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  sleep(600);
  if (!isLocked()) return;
  if (!UNLOCK_PIN) { console.error("TIKTOK_PIN não definido."); process.exit(1); }
  const r = spawnSync("node", [path.join(__dirname, "unlock.js"), UNLOCK_PIN], { stdio: "inherit" });
  if (r.status !== 0) { console.error("Falha ao desbloquear."); process.exit(1); }
}

function dumpRaw() {
  spawnSync("adb", ["shell", "uiautomator", "dump", "/sdcard/ui.xml"], { encoding: "utf8" });
  return adb("shell", "cat", "/sdcard/ui.xml");
}

function dumpUI(retries = 10, interval = 700) {
  for (let i = 0; i < retries; i++) {
    const xml = dumpRaw();
    if (xml && xml.includes("<hierarchy") && xml.length > 500) return xml;
    sleep(interval);
  }
  throw new Error("UI não capturável.");
}

function center(boundsStr) {
  const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return { x: Math.round((+m[1] + +m[3]) / 2), y: Math.round((+m[2] + +m[4]) / 2) };
}

function findNode(xml, attr, value, minY = 0) {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<node\\b[^>]*${attr}="[^"]*${esc}[^"]*"[^>]*>`, "gi");
  let match;
  while ((match = re.exec(xml)) !== null) {
    const bm = match[0].match(/bounds="(\[[^\]]+\]\[[^\]]+\])"/);
    if (!bm) continue;
    const c = center(bm[1]);
    if (c && c.y >= minY) return c;
  }
  return null;
}

function getNodeText(xml, resourceId) {
  const esc = resourceId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const node = xml.match(new RegExp(`<node\\b[^>]*resource-id="${esc}"[^>]*>`));
  if (!node) return null;
  const t = node[0].match(/text="([^"]*)"/);
  return t ? t[1] : null;
}

// ─── Detecta idade com retry ──────────────────────────────────────────────────

function detectAge(videoIndex) {
  let xml = null;
  let ageText = null;

  for (let attempt = 1; attempt <= AGE_MAX_RETRIES; attempt++) {
    if (attempt > 1) sleep(AGE_INTERVAL);
    const raw = dumpRaw();
    if (!raw || !raw.includes("<hierarchy") || raw.length < 500) {
      console.log(`    Tentativa ${attempt}: dump inválido — retry`);
      continue;
    }
    xml = raw;

    // Salva o dump da primeira tentativa de cada vídeo
    if (attempt === 1) {
      fs.writeFileSync(path.join(OUT_DIR, `age_v${String(videoIndex).padStart(2,"0")}_attempt${attempt}.xml`), raw);
    }

    ageText = getNodeText(raw, `${TIKTOK_PACKAGE}:id/tv_post_time`);
    if (ageText !== null) {
      console.log(`    Tentativa ${attempt}: ✓ tv_post_time = "${ageText.trim()}"`);
      break;
    }
    console.log(`    Tentativa ${attempt}: ✗ tv_post_time não encontrado`);
  }

  if (ageText === null) {
    console.log(`    ⚠ Não encontrado após ${AGE_MAX_RETRIES} tentativas.`);
  }

  return ageText;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  if (!adb("devices").split("\n").slice(1).some(l => l.includes("device"))) {
    console.error("Nenhum dispositivo conectado."); process.exit(1);
  }

  unlockIfNeeded();
  adb("shell", "svc", "power", "stayon", "true");

  // Abre TikTok e navega ao perfil
  console.log("\n[1] Abrindo TikTok e buscando perfil...");
  adb("shell", "am", "force-stop", TIKTOK_PACKAGE);
  wakeScreen();
  sleep(800);
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW",
    "-d", `snssdk1233://search?keyword=${SEARCH_QUERY}`, TIKTOK_PACKAGE);
  sleep(4000);
  wakeScreen();

  let xml;
  for (let i = 0; i < 10; i++) {
    xml = dumpUI();
    const pos = findNode(xml, "text", "Usuários") || findNode(xml, "content-desc", "Usuários");
    if (pos) { adb("shell", "input", "tap", String(pos.x), String(pos.y)); break; }
    sleep(1000);
  }
  sleep(2500);

  let profile;
  for (let i = 0; i < 10; i++) {
    xml = dumpUI();
    profile = findNode(xml, "text", SEARCH_QUERY, 300);
    if (profile) break;
    sleep(1000);
  }
  if (!profile) { console.error("Perfil não encontrado."); process.exit(1); }
  console.log(`    Perfil em (${profile.x}, ${profile.y})`);
  adb("shell", "input", "tap", String(profile.x), String(profile.y));
  sleep(3500);
  wakeScreen();

  // Abre primeiro vídeo da grade
  console.log("[2] Abrindo primeiro vídeo da grade...");
  xml = dumpUI();
  const ev2Re = /<node\b[^>]*resource-id="com\.zhiliaoapp\.musically:id\/ev2"[^>]*clickable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/gi;
  const gridVideos = [];
  let gm;
  while ((gm = ev2Re.exec(xml)) !== null) {
    if (+gm[2] < 1100) continue;
    gridVideos.push({ x: Math.round((+gm[1] + +gm[3]) / 2), y: Math.round((+gm[2] + +gm[4]) / 2) });
  }
  gridVideos.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
  if (!gridVideos.length) { console.error("Nenhum vídeo na grade."); process.exit(1); }
  adb("shell", "input", "tap", String(gridVideos[0].x), String(gridVideos[0].y));
  sleep(3500);
  wakeScreen();

  // Loop pelos vídeos
  const results = [];
  for (let i = 0; i < TEST_COUNT; i++) {
    console.log(`\n─── Vídeo ${i + 1}/${TEST_COUNT} ───`);

    console.log("  Pausando...");
    adb("shell", "input", "tap", "540", "600");
    sleep(1200);

    console.log("  Verificando idade:");
    const ageText = detectAge(i);

    let unit = null;
    if (ageText) {
      const m = ageText.match(/(\d+)([mhd])/);
      if (m) unit = m[2];
    }

    results.push({ video: i + 1, ageText: ageText ? ageText.trim() : null, unit });

    // Despausa e scrolla para o próximo
    adb("shell", "input", "tap", "540", "600");
    sleep(500);

    if (i < TEST_COUNT - 1) {
      console.log("  Scrollando para o próximo vídeo...");
      adb("shell", "input", "swipe", "540", "1800", "540", "300", "500");
      sleep(2500);
      wakeScreen();
    }
  }

  // Resumo
  console.log("\n═══════════════════════════════════");
  console.log(" RESUMO");
  console.log("═══════════════════════════════════");
  for (const r of results) {
    const age = r.ageText ?? "não encontrado";
    const flag = r.unit === 'd' ? " ← SERIA EXIT" : r.unit ? " ← ok (continua)" : " ← sem dado";
    console.log(`  Vídeo ${r.video}: ${age}${flag}`);
  }

  adb("shell", "svc", "power", "stayon", "false");
}

main();
