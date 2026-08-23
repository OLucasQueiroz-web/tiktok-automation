#!/usr/bin/env node

const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const { PNG } = require("/home/lucas/Documents/tiktok-automation/node_modules/pngjs");

try {
  fs.readFileSync(`${__dirname}/.env`, "utf8").split("\n").forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !(m[1].trim() in process.env)) process.env[m[1].trim()] = m[2].trim();
  });
} catch {}

const TIKTOK_PACKAGE = "com.zhiliaoapp.musically";
const SEARCH_QUERY = "matheusemaryana";
const LOOP_COUNT = 5;
const UNLOCK_PIN = process.env.TIKTOK_PIN || "";

function adb(...args) {
  const result = spawnSync("adb", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result.stdout.trim();
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
    console.error("Dispositivo bloqueado. Defina TIKTOK_PIN=<senha> ou passe como: TIKTOK_PIN=1234 node open-tiktok.js");
    process.exit(1);
  }
  console.log("Dispositivo bloqueado — desbloqueando via unlock.js...");
  const result = spawnSync("node", [`${__dirname}/unlock.js`, UNLOCK_PIN], { encoding: "utf8", stdio: "inherit" });
  if (result.status !== 0) {
    console.error("Falha ao desbloquear.");
    process.exit(1);
  }
}

function dumpUI(retries = 10, interval = 700) {
  for (let i = 0; i < retries; i++) {
    spawnSync("adb", ["shell", "uiautomator", "dump", "/sdcard/ui.xml"], { encoding: "utf8" });
    const xml = adb("shell", "cat", "/sdcard/ui.xml");
    if (xml && xml.includes("<hierarchy") && xml.length > 500) return xml;
    sleep(interval);
  }
  throw new Error("Não foi possível capturar a UI.");
}

function center(boundsStr) {
  const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return {
    x: Math.round((+m[1] + +m[3]) / 2),
    y: Math.round((+m[2] + +m[4]) / 2),
  };
}

// Nome do produto: texto longo acima de "Adicionar ao carrinho", não sendo preço/botão/info.
// Prefere clickable=true (nome expansível) mas aceita qualquer nó se for o mais longo.
function findProductName(xml) {
  const cartMatch = xml.match(/text="Adicionar ao carrinho"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  const maxY = cartMatch ? +cartMatch[2] : 9999;

  const skipRe = /^(\s*(R\$|\(|\d|#|Adicionar|Comprar|Frete|Economize|vendidos|desconto|ganhe|juros|bônus|autêntico|Loja|Chat|Devolução|100%|2x|Receba|Compre|4\.8|4,|3,|5,|\*))/i;

  const nodeRe = /<node\b([^>]*)>/gi;
  let m, best = null;
  while ((m = nodeRe.exec(xml)) !== null) {
    const attrs = m[1];
    const textM = attrs.match(/text="([^"]{8,})"/);
    if (!textM) continue;
    const text = textM[1].replace(/￼/g, "").trim();
    if (text.length < 8) continue;
    if (skipRe.test(text)) continue;
    const boundsM = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!boundsM) continue;
    const y = Math.round((+boundsM[2] + +boundsM[4]) / 2);
    if (y >= maxY || y < 300) continue;
    const clickable = attrs.includes('clickable="true"');
    const score = text.length + (clickable ? 500 : 0);
    if (!best || score > best.score) {
      best = { x: Math.round((+boundsM[1] + +boundsM[3]) / 2), y, text: textM[1], score };
    }
  }
  return best;
}

function findByResourceId(xml, id) {
  return findNode(xml, "resource-id", id);
}

function findNode(xml, attr, value, minY = 0, maxY = Infinity) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<node\\b[^>]*${attr}="[^"]*${escaped}[^"]*"[^>]*>`, "gi");
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const boundsMatch = match[0].match(/bounds="(\[[^\]]+\]\[[^\]]+\])"/);
    if (!boundsMatch) continue;
    const c = center(boundsMatch[1]);
    if (c && c.y >= minY && c.y <= maxY) return c;
  }
  return null;
}

// Acha o botão de voltar pelo canto superior esquerdo (sem content-desc na página de produto)
function findBackButtonTopLeft(xml) {
  const pattern = /<node\b[^>]*clickable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/gi;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const x1 = +match[1], y1 = +match[2], x2 = +match[3], y2 = +match[4];
    if (x1 < 150 && y1 < 300 && x2 - x1 < 200 && y2 - y1 < 200) {
      return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
    }
  }
  return null;
}

function tap(pos) {
  adb("shell", "input", "tap", String(pos.x), String(pos.y));
}

function findCartByColor() {
  adb("shell", "screencap", "-p", "/sdcard/screen.png");
  adb("pull", "/sdcard/screen.png", "/tmp/tiktok_screen.png");

  const data = fs.readFileSync("/tmp/tiktok_screen.png");
  const png = PNG.sync.read(data);

  const CELL = 60;
  const cells = {};
  for (let y = 1200; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      if (r > 180 && g >= 40 && g <= 140 && b < 70) {
        const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
        cells[key] = (cells[key] || 0) + 1;
      }
    }
  }

  let bestCell = null, bestCount = 0;
  for (const [key, cnt] of Object.entries(cells)) {
    if (cnt > bestCount) { bestCount = cnt; bestCell = key; }
  }

  if (bestCell && bestCount >= 30) {
    const [cx, cy] = bestCell.split(",").map(Number);
    const cart = { x: cx * CELL + CELL / 2, y: cy * CELL + CELL / 2 };
    console.log(`Cluster laranja mais denso em (${cart.x}, ${cart.y}) com ${bestCount} pixels.`);
    return cart;
  }
  return null;
}

// Processa um único vídeo: verifica carrinho, faz o fluxo completo e tira screenshot.
// Retorna true se o produto foi processado, false se não havia carrinho.
function processVideo(scrollNum, productNum) {
  console.log(`\n=== [Scroll ${scrollNum + 1}] Buscando produto ${productNum + 1}/${LOOP_COUNT} ===`);

  // Pausa o vídeo tocando na parte central superior
  console.log("Pausando vídeo...");
  adb("shell", "input", "tap", "540", "600");
  sleep(1200);

  // Busca carrinho via XML com até 4 tentativas (TikTok pode demorar a renderizar)
  // "Loja" está sempre escrito no botão — é o seletor mais confiável.
  console.log("Procurando carrinho...");
  let xml = dumpUI();
  let cart = null;
  for (let attempt = 0; attempt < 4 && !cart; attempt++) {
    if (attempt > 0) { sleep(800); xml = dumpUI(); }
    cart =
      findNode(xml, "text", "Loja") ||
      findNode(xml, "content-desc", "Sacola de compras") ||
      findNode(xml, "content-desc", "Carrinho de compras");
  }

  if (!cart) {
    console.log("Sem carrinho neste vídeo — pulando.");
    adb("shell", "input", "tap", "540", "600"); // despausa
    sleep(500);
    return false;
  }

  // Retoma e clica no carrinho
  console.log(`Carrinho em (${cart.x}, ${cart.y}), clicando...`);
  adb("shell", "input", "tap", "540", "600"); // despausa
  sleep(500);
  tap(cart);
  sleep(2000);

  // Clica em "Ganhe R$ XX,XX por venda"
  // Esse texto fica em WebView — UIAutomator não o enxerga.
  // Âncora: resource-id agz = "Adicionar ao carrinho" (✓ 8/8 pelo diagnóstico).
  // A entrada de comissão fica ~155px acima do topo desse botão.
  console.log("Procurando 'Ganhe R$ por venda'...");
  xml = dumpUI();
  const agzMatch = xml.match(/resource-id="com\.zhiliaoapp\.musically:id\/agz"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  const cartTopY = agzMatch ? +agzMatch[2] : 2028;
  const ganhePos = { x: 300, y: cartTopY - 155 };

  console.log(`Clicando em 'Ganhe R$ por venda' em (${ganhePos.x}, ${ganhePos.y})...`);
  tap(ganhePos);
  sleep(2500);

  // Aguarda a folha de promoção e clica em "Adicionar à vitrine" ou detecta "Criar agora"
  console.log("Aguardando folha de promoção carregar...");
  sleep(3000);
  xml = dumpUI();

  const btnVitrine = findNode(xml, "content-desc", "vitrine");
  const btnCriar   = findNode(xml, "content-desc", "Criar agora");

  if (btnVitrine) {
    console.log(`Botão 'Adicionar à vitrine' em (${btnVitrine.x}, ${btnVitrine.y}), clicando...`);
    tap(btnVitrine);
    sleep(2500);
    xml = dumpUI();
  } else if (btnCriar) {
    console.log("Botão 'Criar agora' detectado — não clica, apenas volta.");
  } else {
    console.warn("Folha de promoção não abriu — pulando vídeo.");
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    sleep(1000);
    return false;
  }

  // Fecha a folha de promoção (seta "Para baixo" ou "Fechar")
  console.log("Fechando folha de promoção...");
  if (!xml) xml = dumpUI();
  const sheetBack =
    findNode(xml, "content-desc", "Para baixo") ||
    findNode(xml, "content-desc", "Fechar");

  if (sheetBack) {
    console.log(`Seta em (${sheetBack.x}, ${sheetBack.y}), clicando...`);
    tap(sheetBack);
    sleep(1500);
  } else {
    console.warn("Seta não encontrada — usando BACK.");
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    sleep(1500);
  }

  // Fecha o vídeo pequeno flutuante (Fechar com x > 500)
  console.log("Procurando X do vídeo pequeno...");
  xml = dumpUI();
  const allFechares = [];
  const fecharRe = /content-desc="Fechar"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  let fm;
  while ((fm = fecharRe.exec(xml)) !== null) {
    allFechares.push({ x: Math.round((+fm[1] + +fm[3]) / 2), y: Math.round((+fm[2] + +fm[4]) / 2) });
  }
  const videoClose = allFechares.filter(f => f.x > 500).sort((a, b) => a.y - b.y)[0] || null;

  if (videoClose) {
    console.log(`X do vídeo em (${videoClose.x}, ${videoClose.y}), clicando...`);
    tap(videoClose);
    sleep(1000);
  } else {
    console.warn("X do vídeo não encontrado.");
  }

  // Scroll leve para revelar o produto
  console.log("Scrollando levemente...");
  adb("shell", "input", "swipe", "540", "1200", "540", "1120", "400");
  sleep(800);

  // Clica no nome do produto para expandir e tira screenshot
  // Usa resource-id ja5 (✓ 8/8 pelo diagnóstico) antes da heurística legada.
  console.log("Procurando nome do produto...");
  xml = dumpUI();

  let productName = null;
  const ja5Match = xml.match(/resource-id="com\.zhiliaoapp\.musically:id\/ja5"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (ja5Match) {
    const textMatch = xml.match(/resource-id="com\.zhiliaoapp\.musically:id\/ja5"[^>]*text="([^"]+)"/);
    productName = {
      x: Math.round((+ja5Match[1] + +ja5Match[3]) / 2),
      y: Math.round((+ja5Match[2] + +ja5Match[4]) / 2),
      text: textMatch ? textMatch[1] : "",
    };
  } else {
    productName = findProductName(xml);
  }

  let rawName = "";
  if (productName) {
    console.log(`Nome do produto em (${productName.x}, ${productName.y}), clicando...`);
    tap(productName);
    sleep(1000);
    adb("shell", "input", "swipe", "540", "1200", "540", "1120", "400");
    sleep(800);

    xml = dumpUI();
    // Tenta ja5 expandido primeiro, senão heurística legada
    let expandedName = null;
    const ja5Exp = xml.match(/resource-id="com\.zhiliaoapp\.musically:id\/ja5"[^>]*text="([^"]+)"/);
    if (ja5Exp) expandedName = { text: ja5Exp[1] };
    else expandedName = findProductName(xml);

    rawName = (expandedName?.text || productName.text)
      .replace(/&#\d+;/g, "")
      .replace(/&[a-z]+;/g, "")
      .replace(/[￼�]/g, "")
      .replace(/[\/\\\x00-\x1f]/g, "")
      .trim();

    const filename = `/home/lucas/Documents/tiktok-automation/screenshots/${rawName}.png`;
    fs.mkdirSync("/home/lucas/Documents/tiktok-automation/screenshots", { recursive: true });
    adb("shell", "screencap", "-p", "/sdcard/screen.png");
    adb("pull", "/sdcard/screen.png", filename);
    console.log(`Screenshot salvo em: ${filename}`);
  } else {
    console.warn("Nome do produto não encontrado.");
  }

  // Fecha o overlay do produto e volta ao vídeo.
  // O produto aparece como bottom sheet SOBRE o vídeo — nunca como página separada.
  // KEYCODE_BACK fecha o overlay sem sair do vídeo.
  // bov / "Voltar" / findBackButtonTopLeft são do vídeo (vão para o perfil) — NÃO usar aqui.
  console.log("Fechando overlay do produto...");
  xml = dumpUI();
  if (xml.includes('id/agz') || xml.includes('id/ja5') || xml.includes('id/yvg')) {
    adb("shell", "input", "keyevent", "KEYCODE_BACK");
    sleep(1200);
    console.log("Overlay fechado, de volta ao vídeo.");
  } else {
    console.log("Overlay já fechado — sem ação.");
  }

  return rawName;
}

function openTikTok() {
  if (!adb("devices").split("\n").slice(1).some(l => l.includes("device"))) {
    console.error("Nenhum dispositivo conectado.");
    process.exit(1);
  }

  unlockIfNeeded();
  adb("shell", "svc", "power", "stayon", "true");

  // 1. Fecha e abre a busca
  console.log("Fechando TikTok...");
  adb("shell", "am", "force-stop", TIKTOK_PACKAGE);
  wakeScreen();
  sleep(800);

  console.log(`Buscando "${SEARCH_QUERY}"...`);
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW",
    "-d", `snssdk1233://search?keyword=${SEARCH_QUERY}`, TIKTOK_PACKAGE);
  sleep(4000);
  wakeScreen();

  // 2. Clica na aba "Usuários" para evitar confundir com vídeos que mencionam o perfil
  console.log("Clicando na aba Usuários...");
  let xml;
  for (let i = 0; i < 10; i++) {
    xml = dumpUI();
    const abaUsuarios = findNode(xml, "text", "Usuários") || findNode(xml, "content-desc", "Usuários");
    if (abaUsuarios) { tap(abaUsuarios); break; }
    console.log(`Aguardando aba Usuários... (${i + 1}/10)`);
    sleep(1000);
  }
  sleep(2500);

  // 3. Pega o primeiro resultado da aba Usuários
  console.log("Navegando para o perfil...");
  let profile;
  for (let i = 0; i < 10; i++) {
    xml = dumpUI();
    profile = findNode(xml, "text", SEARCH_QUERY, 300);
    if (profile) break;
    console.log(`Resultado ainda carregando... (${i + 1}/10)`);
    sleep(1000);
  }
  if (!profile) { console.error("Perfil não encontrado."); process.exit(1); }
  console.log(`Perfil em (${profile.x}, ${profile.y}), clicando...`);
  tap(profile);
  sleep(3500);
  wakeScreen();

  // 3. Abre o primeiro vídeo da grade via resource-id confirmado (ev2)
  console.log("Procurando primeiro vídeo na grade do perfil...");
  xml = dumpUI();
  const ev2Re = /<node\b[^>]*resource-id="com\.zhiliaoapp\.musically:id\/ev2"[^>]*clickable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/gi;
  const gridVideos = [];
  let gm;
  while ((gm = ev2Re.exec(xml)) !== null) {
    const y1 = +gm[2];
    if (y1 < 1100) continue;
    gridVideos.push({ x: Math.round((+gm[1] + +gm[3]) / 2), y: Math.round((y1 + +gm[4]) / 2) });
  }
  gridVideos.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  if (gridVideos.length === 0) { console.error("Nenhum vídeo encontrado na grade."); process.exit(1); }
  const firstVideo = gridVideos[0];
  console.log(`Primeiro vídeo em (${firstVideo.x}, ${firstVideo.y}), clicando...`);
  tap(firstVideo);
  sleep(3500);
  wakeScreen();

  // Loop principal: processa vídeo e swipa para o próximo no feed do perfil.
  // Vídeos sem carrinho e produtos duplicados não consomem slot — o loop só avança
  // quando encontra um produto novo. MAX_SCROLLS evita loop infinito.
  const seenProducts = new Set();
  let processed = 0;
  let scrollsDone = 0;
  const MAX_SCROLLS = LOOP_COUNT * 5;

  while (processed < LOOP_COUNT && scrollsDone < MAX_SCROLLS) {
    const result = processVideo(scrollsDone, processed);
    scrollsDone++;

    if (result === false) {
      // sem carrinho — não conta, não scrolla aqui pois o processVideo já despausa
    } else if (result && seenProducts.has(result)) {
      console.log(`Produto duplicado nesta automação: "${result}" — não conta no total.`);
    } else {
      if (result) seenProducts.add(result);
      processed++;
    }

    if (processed < LOOP_COUNT) {
      console.log("Indo para o próximo vídeo...");
      adb("shell", "input", "swipe", "540", "1800", "540", "300", "500");
      sleep(2500);
      wakeScreen();
    }
  }

  // Sai do vídeo ao final
  console.log("Saindo do vídeo...");
  const finalXml = dumpUI();
  const finalBack =
    findByResourceId(finalXml, "com.zhiliaoapp.musically:id/bov") ||
    findNode(finalXml, "content-desc", "Voltar") ||
    findNode(finalXml, "content-desc", "Navigate up");
  if (finalBack) tap(finalBack);
  else adb("shell", "input", "keyevent", "KEYCODE_BACK");
  sleep(1500);

  adb("shell", "svc", "power", "stayon", "false");
  console.log(`\nConcluído! ${processed}/${LOOP_COUNT} vídeos com produto processados.`);
}

openTikTok();
