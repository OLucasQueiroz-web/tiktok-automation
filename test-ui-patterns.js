#!/usr/bin/env node
/**
 * Diagnóstico de padrões de UI do TikTok Shop
 *
 * Navega por N vídeos do perfil, captura dumps de UI em cada etapa-chave
 * e gera um relatório comparativo para identificar quais seletores são
 * estáveis (resource-id) vs. frágeis (text/content-desc/coordenadas).
 *
 * Uso: node test-ui-patterns.js [quantidade_de_videos]
 * Saída: ui-analysis/report.json + ui-analysis/report.txt
 */

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const TIKTOK_PACKAGE = "com.zhiliaoapp.musically";
const SEARCH_QUERY = "felipyoms1g";
const TEST_COUNT = parseInt(process.argv[2] || "8", 10);
const OUT_DIR = path.join(__dirname, "ui-analysis");
const UNLOCK_PIN = process.env.TIKTOK_PIN || "";

// ─── Primitivos ADB ──────────────────────────────────────────────────────────

function adb(...args) {
  const r = spawnSync("adb", args, { encoding: "utf8" });
  if (r.error) throw r.error;
  return r.stdout.trim();
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function wakeScreen() {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  sleep(300);
}

function isLocked() {
  const out = adb("shell", "dumpsys", "window");
  return (
    out.includes("mDreamingLockscreen=true") ||
    out.includes("isStatusBarKeyguard=true") ||
    out.includes("mShowingLockscreen=true")
  );
}

function unlockIfNeeded() {
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  sleep(600);
  if (!isLocked()) return;
  if (!UNLOCK_PIN) {
    console.error("Dispositivo bloqueado. Defina TIKTOK_PIN=<senha> antes de rodar.");
    process.exit(1);
  }
  console.log("Dispositivo bloqueado — desbloqueando...");
  adb("shell", "input", "swipe", "500", "1500", "500", "500", "300");
  sleep(600);
  adb("shell", "input", "text", UNLOCK_PIN);
  sleep(200);
  adb("shell", "input", "keyevent", "KEYCODE_ENTER");
  sleep(800);
  if (isLocked()) {
    console.error("Falha ao desbloquear. Verifique TIKTOK_PIN.");
    process.exit(1);
  }
  console.log("Desbloqueado.");
}

function tap(x, y) {
  adb("shell", "input", "tap", String(x), String(y));
}

function dumpUI(retries = 10, interval = 700) {
  for (let i = 0; i < retries; i++) {
    spawnSync("adb", ["shell", "uiautomator", "dump", "/sdcard/ui.xml"], { encoding: "utf8" });
    const xml = adb("shell", "cat", "/sdcard/ui.xml");
    if (xml && xml.includes("<hierarchy") && xml.length > 500) return xml;
    sleep(interval);
  }
  throw new Error("UI não capturável após retries.");
}

// ─── Parsing de XML ───────────────────────────────────────────────────────────

function center(boundsStr) {
  const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return { x: Math.round((+m[1] + +m[3]) / 2), y: Math.round((+m[2] + +m[4]) / 2) };
}

function getAttr(attrs, name) {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : "";
}

/** Extrai todos os nós com ao menos um identificador útil */
function parseNodes(xml) {
  const nodeRe = /<node\b([^>]*)>/gi;
  const nodes = [];
  let m;
  while ((m = nodeRe.exec(xml)) !== null) {
    const a = m[1];
    const resourceId  = getAttr(a, "resource-id");
    const contentDesc = getAttr(a, "content-desc");
    const text        = getAttr(a, "text");
    const cls         = getAttr(a, "class");
    const bounds      = getAttr(a, "bounds");
    const clickable   = a.includes('clickable="true"');
    const enabled     = a.includes('enabled="true"');

    if (!resourceId && !contentDesc && !text) continue;
    if (!bounds) continue;

    nodes.push({ resourceId, contentDesc, text, class: cls, bounds, clickable, enabled, center: center(bounds) });
  }
  return nodes;
}

/** Retorna nós com resource-id ou que contenham palavras-chave de shop */
const SHOP_KEYWORDS = ["carrinho","sacola","vitrine","adicionar","ganhe","comprar","produto","fechar","voltar","back","navigate","loja","shop","cart","store","close"];
function filterInteresting(nodes) {
  return nodes.filter(n => {
    if (n.resourceId) return true;
    const hay = `${n.contentDesc} ${n.text}`.toLowerCase();
    return SHOP_KEYWORDS.some(k => hay.includes(k));
  });
}

// ─── Busca de nós no XML ─────────────────────────────────────────────────────

function findNode(xml, attr, value, minY = 0, maxY = Infinity) {
  const esc = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<node\\b[^>]*${attr}="[^"]*${esc}[^"]*"[^>]*>`, "gi");
  let match;
  while ((match = re.exec(xml)) !== null) {
    const bm = match[0].match(/bounds="(\[[^\]]+\]\[[^\]]+\])"/);
    if (!bm) continue;
    const c = center(bm[1]);
    if (c && c.y >= minY && c.y <= maxY) return c;
  }
  return null;
}

function findByResourceId(xml, id) {
  return findNode(xml, "resource-id", id);
}

// ─── Coleta de dados por etapa ────────────────────────────────────────────────

const captures = []; // { videoIndex, step, nodes, interesting, raw }

function capture(videoIndex, step, xml) {
  const nodes = parseNodes(xml);
  const interesting = filterInteresting(nodes);

  captures.push({ videoIndex, step, nodes, interesting });

  // Salva o XML bruto para inspeção manual
  const file = path.join(OUT_DIR, `v${String(videoIndex).padStart(2,"0")}_${step}.xml`);
  fs.writeFileSync(file, xml, "utf8");
  console.log(`  [dump] ${path.basename(file)} — ${nodes.length} nós, ${interesting.length} relevantes`);
}

// ─── Navegação ────────────────────────────────────────────────────────────────

function navigateToProfile() {
  console.log("\n=== Navegando ao perfil ===");
  adb("shell", "am", "force-stop", TIKTOK_PACKAGE);
  wakeScreen();
  sleep(800);

  adb("shell", "am", "start", "-a", "android.intent.action.VIEW",
    "-d", `snssdk1233://search?keyword=${SEARCH_QUERY}`, TIKTOK_PACKAGE);
  sleep(4000);
  wakeScreen();

  // Aba Usuários
  let xml;
  for (let i = 0; i < 12; i++) {
    xml = dumpUI();
    const pos = findNode(xml, "text", "Usuários") || findNode(xml, "content-desc", "Usuários");
    if (pos) { tap(pos.x, pos.y); break; }
    sleep(1000);
  }
  sleep(2500);

  // Primeiro resultado
  xml = dumpUI();
  capture(-1, "search_results", xml);

  let profile;
  for (let i = 0; i < 12; i++) {
    xml = dumpUI();
    profile = findNode(xml, "text", SEARCH_QUERY, 300);
    if (profile) break;
    sleep(1000);
  }
  if (!profile) throw new Error("Perfil não encontrado.");
  tap(profile.x, profile.y);
  sleep(3500);
  wakeScreen();

  xml = dumpUI();
  capture(-1, "profile_page", xml);
  return xml;
}

/**
 * Coleta todas as posições de vídeos visíveis na grade do perfil.
 * Retorna lista ordenada por posição (linha a linha, esquerda p/ direita).
 */
function collectVideoPositions(xml) {
  // resource-id confirmado por dump real da grade do perfil
  const THUMB_RID = `${TIKTOK_PACKAGE}:id/ev2`;
  const ridEsc = THUMB_RID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<node\\b[^>]*resource-id="${ridEsc}"[^>]*clickable="true"[^>]*>`, "gi");
  const positions = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const bm = m[0].match(/bounds="(\[[^\]]+\]\[[^\]]+\])"/);
    if (!bm) continue;
    const c = center(bm[1]);
    // Grade começa depois do cabeçalho do perfil (~y>1100)
    if (c && c.y > 1100) positions.push(c);
  }
  if (positions.length >= 1) {
    console.log(`  Thumbnails via resource-id "${THUMB_RID}": ${positions.length} encontrados`);
    return positions.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
  }

  // Fallback: contagem de views (só se ev2 não apareceu)
  const numPattern = /<node\b[^>]*text="(\d[\d.,\s]*(?:mil|k)?)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/gi;
  const candidates = [];
  while ((m = numPattern.exec(xml)) !== null) {
    const y1 = +m[3];
    if (y1 < 1100) continue;
    candidates.push({
      x: Math.round((+m[2] + +m[4]) / 2),
      y: Math.round((y1 + +m[5]) / 2),
    });
  }
  const sorted = candidates.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);
  console.log(`  Thumbnails via fallback de views: ${sorted.length} encontrados`);
  return sorted;
}

/**
 * Garante que estamos na página do perfil do Felipy.
 * Usa o activity/package atual para detectar se saiu e navega de volta.
 */
function ensureOnProfile() {
  // Verifica se o TikTok ainda está em foco
  const focused = adb("shell", "dumpsys", "window", "windows");
  if (!focused.includes(TIKTOK_PACKAGE)) {
    console.log("  TikTok saiu do foco — reabrindo perfil...");
    navigateToProfile();
    return dumpUI();
  }

  // Pressiona BACK até voltar à grade (máx 5 vezes)
  for (let i = 0; i < 5; i++) {
    const xml = dumpUI();
    // Heurística: grade do perfil tem múltiplos nós em grid com y > 500
    const positions = collectVideoPositions(xml);
    if (positions.length >= 3) return xml;
    console.log(`  Ainda não estou na grade do perfil, BACK... (${i + 1}/5)`);
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    sleep(1200);
  }
  return dumpUI();
}

// ─── Análise de padrões ───────────────────────────────────────────────────────

function analyzePatterns() {
  // Agrupa capturas por step
  const byStep = {};
  for (const c of captures) {
    if (!byStep[c.step]) byStep[c.step] = [];
    byStep[c.step].push(c);
  }

  const report = { totalVideos: TEST_COUNT, steps: {}, summary: {} };

  for (const [step, caps] of Object.entries(byStep)) {
    const total = caps.length;
    const ridCount = {}, ridValues = {}, ridClickable = {};

    for (const cap of caps) {
      const seen = new Set();
      for (const n of cap.interesting) {
        if (!n.resourceId || seen.has(n.resourceId)) continue;
        seen.add(n.resourceId);
        ridCount[n.resourceId] = (ridCount[n.resourceId] || 0) + 1;
        if (!ridValues[n.resourceId]) ridValues[n.resourceId] = new Set();
        if (n.text) ridValues[n.resourceId].add(n.text.slice(0, 80));
        if (n.contentDesc) ridValues[n.resourceId].add(`[desc:${n.contentDesc.slice(0, 60)}]`);
        ridClickable[n.resourceId] = n.clickable;
      }
    }

    report.steps[step] = {
      captures: total,
      resourceIds: Object.entries(ridCount)
        .sort((a, b) => b[1] - a[1])
        .map(([rid, count]) => ({
          resourceId: rid,
          freq: `${count}/${total}`,
          pct: Math.round(count / total * 100),
          stable: count === total,
          clickable: ridClickable[rid],
          sampleValues: [...ridValues[rid]].slice(0, 4),
        })),
    };
  }

  // Resumo: quais resource-ids aparecem de forma estável nos vídeos com carrinho
  const videoSteps = Object.keys(byStep).filter(s => s.startsWith("video_"));
  const cartSteps  = ["after_cart_tap", "product_sheet", "ganhe_area"];
  report.summary.stableVideoRids = Object.entries(
    (report.steps["video_playing"] || report.steps["video_open"] || { resourceIds: [] }).resourceIds
  ).filter(([, v]) => v.stable).map(([,v]) => v.resourceId);

  return report;
}

// ─── Loop principal de vídeos ─────────────────────────────────────────────────

function processVideo(index) {
  console.log(`\n─── Vídeo ${index + 1}/${TEST_COUNT} ───`);

  // Estado "reproduzindo"
  sleep(1500);
  let xml = dumpUI();
  capture(index, "video_playing", xml);

  // Pausa tocando no centro superior
  tap(540, 600);
  sleep(1200);
  xml = dumpUI();
  capture(index, "video_paused", xml);

  // Busca carrinho — testa resource-ids conhecidos antes do fallback
  const cartRids = [
    `${TIKTOK_PACKAGE}:id/shopping_bag`,
    `${TIKTOK_PACKAGE}:id/cart_button`,
    `${TIKTOK_PACKAGE}:id/shop_cart`,
    `${TIKTOK_PACKAGE}:id/iv_shopping_bag`,
  ];
  let cart = null;
  let cartFoundBy = "none";

  for (const rid of cartRids) {
    cart = findByResourceId(xml, rid);
    if (cart) { cartFoundBy = `resource-id:${rid}`; break; }
  }

  if (!cart) {
    cart = findNode(xml, "content-desc", "Sacola de compras") ||
           findNode(xml, "content-desc", "Carrinho de compras") ||
           findNode(xml, "text", "Loja");
    if (cart) cartFoundBy = "content-desc/text";
  }

  console.log(`  Carrinho: ${cart ? `(${cart.x},${cart.y}) via ${cartFoundBy}` : "NÃO ENCONTRADO"}`);

  if (!cart) {
    tap(540, 600); // despausa
    sleep(500);
    return { hasCart: false, cartFoundBy: "none" };
  }

  // Retoma e clica no carrinho
  tap(540, 600);
  sleep(500);
  tap(cart.x, cart.y);
  sleep(2000);

  xml = dumpUI();
  capture(index, "after_cart_tap", xml);

  // "Ganhe R$ por venda" — testa resource-ids
  const ganheRids = [
    `${TIKTOK_PACKAGE}:id/commission_entry`,
    `${TIKTOK_PACKAGE}:id/affiliate_commission`,
    `${TIKTOK_PACKAGE}:id/earn_commission`,
    `${TIKTOK_PACKAGE}:id/seller_commission_text`,
  ];
  let ganhe = null, ganheFoundBy = "none";
  for (const rid of ganheRids) {
    ganhe = findByResourceId(xml, rid);
    if (ganhe) { ganheFoundBy = `resource-id:${rid}`; break; }
  }
  if (!ganhe) {
    ganhe = findNode(xml, "text", "Ganhe");
    if (ganhe) ganheFoundBy = "text:Ganhe";
  }
  // Fallback posicional (igual ao original)
  if (!ganhe) {
    const addToCartMatch = xml.match(/text="Adicionar ao carrinho"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    const cartTopY = addToCartMatch ? +addToCartMatch[2] : 2028;
    ganhe = { x: 300, y: cartTopY - 155 };
    ganheFoundBy = "positional-fallback";
  }
  console.log(`  Ganhe R$: (${ganhe.x},${ganhe.y}) via ${ganheFoundBy}`);

  tap(ganhe.x, ganhe.y);
  sleep(2500);

  xml = dumpUI();
  capture(index, "product_sheet", xml);
  sleep(1500);

  xml = dumpUI();
  capture(index, "promo_sheet", xml);

  // Botão "Adicionar à vitrine"
  const vitrineRids = [
    `${TIKTOK_PACKAGE}:id/add_to_showcase_btn`,
    `${TIKTOK_PACKAGE}:id/btn_add_showcase`,
    `${TIKTOK_PACKAGE}:id/showcase_button`,
  ];
  let vitrine = null, vitrineFoundBy = "none";
  for (const rid of vitrineRids) {
    vitrine = findByResourceId(xml, rid);
    if (vitrine) { vitrineFoundBy = `resource-id:${rid}`; break; }
  }
  if (!vitrine) {
    vitrine = findNode(xml, "content-desc", "vitrine") || findNode(xml, "text", "vitrine");
    if (vitrine) vitrineFoundBy = "content-desc/text";
  }
  console.log(`  Vitrine: ${vitrine ? `(${vitrine.x},${vitrine.y}) via ${vitrineFoundBy}` : "NÃO ENCONTRADO"}`);

  // Fecha tudo com BACK — volta à grade do perfil
  for (let b = 0; b < 5; b++) {
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    sleep(900);
    const checkXml = dumpUI();
    const pos = collectVideoPositions(checkXml);
    if (pos.length >= 3) {
      console.log(`  De volta à grade após ${b + 1} BACK(s)`);
      break;
    }
  }

  return {
    hasCart: true,
    cartFoundBy,
    ganheFoundBy,
    vitrineFoundBy,
    vitrineFound: !!vitrine,
  };
}

// ─── Geração de relatório texto ───────────────────────────────────────────────

function generateTextReport(report, results) {
  const lines = [
    "═══════════════════════════════════════════════════════════════",
    " RELATÓRIO DE PADRÕES DE UI — TikTok Shop",
    `═══════════════════════════════════════════════════════════════`,
    `Vídeos analisados : ${TEST_COUNT}`,
    `Com carrinho      : ${results.filter(r => r.hasCart).length}`,
    "",
    "─── Como o carrinho foi encontrado ─────────────────────────────",
  ];

  const cartMethods = {};
  for (const r of results) cartMethods[r.cartFoundBy] = (cartMethods[r.cartFoundBy] || 0) + 1;
  for (const [m, c] of Object.entries(cartMethods)) lines.push(`  ${m}: ${c}x`);

  lines.push("", "─── Como 'Ganhe R$' foi encontrado ─────────────────────────────");
  const ganheMethods = {};
  for (const r of results.filter(r => r.hasCart)) ganheMethods[r.ganheFoundBy] = (ganheMethods[r.ganheFoundBy] || 0) + 1;
  for (const [m, c] of Object.entries(ganheMethods)) lines.push(`  ${m}: ${c}x`);

  lines.push("", "─── Resource-IDs por etapa (estáveis primeiro) ──────────────────");
  for (const [step, data] of Object.entries(report.steps)) {
    if (data.resourceIds.length === 0) continue;
    lines.push(`\n  [${step}] — ${data.captures} capturas`);
    const sorted = [...data.resourceIds].sort((a, b) => b.pct - a.pct);
    for (const r of sorted.slice(0, 20)) {
      const flag = r.stable ? "✓" : "~";
      const clickMark = r.clickable ? " [clickable]" : "";
      lines.push(`    ${flag} ${r.freq.padEnd(6)} ${r.resourceId}${clickMark}`);
      if (r.sampleValues.length) lines.push(`           └─ "${r.sampleValues[0]}"`);
    }
  }

  lines.push("", "─── Elementos sem resource-id (frágeis) ─────────────────────────");
  const noRidByStep = {};
  for (const cap of captures) {
    for (const n of cap.interesting) {
      if (n.resourceId) continue;
      const key = `${cap.step}`;
      if (!noRidByStep[key]) noRidByStep[key] = new Set();
      const label = n.contentDesc || n.text;
      if (label) noRidByStep[key].add(label.slice(0, 80));
    }
  }
  for (const [step, vals] of Object.entries(noRidByStep)) {
    lines.push(`\n  [${step}]`);
    for (const v of [...vals].slice(0, 10)) lines.push(`    • "${v}"`);
  }

  lines.push("", "═══════════════════════════════════════════════════════════════");
  lines.push(" RECOMENDAÇÕES");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("");
  lines.push("1. Substitua findNode por findByResourceId nos IDs marcados com ✓");
  lines.push("2. Elementos sem resource-id e com texto variável por locale");
  lines.push("   são de alto risco — use posição relativa a um elemento estável.");
  lines.push("3. IDs com frequência < 100% (~) são condicionais (modal, webview)");
  lines.push("   — mantenha o fallback atual para esses.");
  lines.push("");

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  if (!adb("devices").split("\n").slice(1).some(l => l.includes("device"))) {
    console.error("Nenhum dispositivo conectado.");
    process.exit(1);
  }

  unlockIfNeeded();
  adb("shell", "svc", "power", "stayon", "true");

  let profileXml = navigateToProfile();

  const results = [];
  let videosProcessed = 0;
  let gridScrolls = 0;
  const MAX_SCROLLS = 5;

  while (videosProcessed < TEST_COUNT) {
    // Coleta posições visíveis na grade atual
    let positions = collectVideoPositions(profileXml);

    if (positions.length === 0) {
      if (gridScrolls >= MAX_SCROLLS) {
        console.log("Sem mais vídeos na grade após scrolls — encerrando.");
        break;
      }
      console.log("Nenhum vídeo visível — scrollando grade...");
      adb("shell", "input", "swipe", "540", "1800", "540", "1000", "600");
      sleep(1500);
      profileXml = dumpUI();
      gridScrolls++;
      continue;
    }

    // Pega o primeiro da lista (já ordenado por posição)
    const target = positions[0];
    console.log(`\n=== Abrindo vídeo ${videosProcessed + 1}/${TEST_COUNT} em (${target.x},${target.y}) ===`);
    tap(target.x, target.y);
    sleep(3500);
    wakeScreen();

    const r = processVideo(videosProcessed);
    results.push(r);
    videosProcessed++;

    // Volta à grade e remove o vídeo já processado (scroll leve se ficou fora)
    profileXml = ensureOnProfile();

    // Scroll leve para que o próximo vídeo não seja o mesmo
    // (após BACK o foco pode estar no vídeo que acabamos de abrir)
    adb("shell", "input", "swipe", "540", "1400", "540", "1100", "400");
    sleep(1000);
    profileXml = dumpUI();
  }

  adb("shell", "svc", "power", "stayon", "false");

  console.log("\n=== Gerando relatório ===");
  const report = analyzePatterns();
  report.results = results;

  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  const txt = generateTextReport(report, results);
  fs.writeFileSync(path.join(OUT_DIR, "report.txt"), txt);

  console.log(txt);
  console.log(`\nArquivos salvos em: ${OUT_DIR}`);
}

main();
