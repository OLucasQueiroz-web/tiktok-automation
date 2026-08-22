#!/usr/bin/env node

const { execSync, spawnSync } = require("child_process");

const PIN = process.argv[2];

if (!PIN) {
  console.error("Uso: node unlock.js <senha>");
  console.error("Exemplo: node unlock.js 1234");
  process.exit(1);
}

function adb(...args) {
  const result = spawnSync("adb", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result.stdout.trim();
}

function sleep(ms) {
  execSync(`sleep ${ms / 1000}`);
}

function getScreenState() {
  const output = adb("shell", "dumpsys", "power");
  const match = output.match(/mWakefulness=(\w+)/);
  return match ? match[1] : "Unknown";
}

function isLocked() {
  const output = adb("shell", "dumpsys", "window");
  return (
    output.includes("mDreamingLockscreen=true") ||
    output.includes("isStatusBarKeyguard=true") ||
    output.includes("mShowingLockscreen=true")
  );
}

function wakeScreen() {
  if (getScreenState() !== "Awake") {
    console.log("Ligando a tela...");
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    sleep(600);
  }
}

function unlock(pin) {
  const devices = adb("devices")
    .split("\n")
    .slice(1)
    .filter((l) => l.includes("device"));

  if (devices.length === 0) {
    console.error("Nenhum dispositivo Android conectado.");
    process.exit(1);
  }

  wakeScreen();

  if (!isLocked()) {
    console.log("Dispositivo já está desbloqueado.");
    return;
  }

  // swipe para revelar o campo de senha
  console.log("Deslizando para abrir o campo de senha...");
  adb("shell", "input", "swipe", "500", "1500", "500", "500", "300");
  sleep(600);

  // digita a senha
  console.log("Digitando senha...");
  adb("shell", "input", "text", pin);
  sleep(200);
  adb("shell", "input", "keyevent", "KEYCODE_ENTER");
  sleep(800);

  if (isLocked()) {
    console.error("Falha ao desbloquear. Verifique se a senha está correta.");
    process.exit(1);
  }

  console.log("Desbloqueado com sucesso!");
}

unlock(PIN);
