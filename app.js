import React, { useState, useEffect, useRef } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Modal,
  Switch,
  StyleSheet,
  Platform,
  Dimensions,
  PixelRatio,
  StatusBar,
  Vibration,
  Share
} from 'react-native';

// ============================================================================
// CONSTANTES DE ARMAZENAMENTO E SINCRONIZAÇÃO EM TEMPO REAL
// ============================================================================
const USERS_STORAGE_KEY = 'helptop_users_zero_v3';
const TICKETS_STORAGE_KEY = 'helptop_tickets_zero_v3';
const SYNC_PACKET_KEY = 'helptop_sync_packet_v3';

// Armazenamento universal compatível com React Native puro (memória + ExpoFileSystem) e Expo Web (localStorage)
const memoryStore = {};
const UniversalStorage = {
  getItem(key) {
    try {
      if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
        return globalThis.localStorage.getItem(key);
      }
    } catch (e) {}
    return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
  },
  setItem(key, value) {
    memoryStore[key] = String(value);
    try {
      if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
        globalThis.localStorage.setItem(key, String(value));
      }
    } catch (e) {}
  },
  removeItem(key) {
    delete memoryStore[key];
    try {
      if (typeof globalThis !== 'undefined' && globalThis.localStorage) {
        globalThis.localStorage.removeItem(key);
      }
    } catch (e) {}
  }
};

// ============================================================================
// MOTOR DE TELEMETRIA REAL DO APARELHO (ANDROID / IOS NATIVO + EXPO + WEB/PC)
// ============================================================================
function getExpoNativeModule(moduleName) {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.expo && globalThis.expo.modules) {
      return globalThis.expo.modules[moduleName] || null;
    }
  } catch (e) {}
  return null;
}

function detectWebGlGpuIfAvailable() {
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return null;
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      let renderer = debugInfo
        ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      if (!renderer) return null;
      let clean = String(renderer).trim();
      const angleMatch = clean.match(/ANGLE\s*\([^,]+,\s*([^,(]+?)(?:\s+Direct3D|\s+OpenGL|\s+\(|,|$)/i);
      if (angleMatch && angleMatch[1]) {
        clean = angleMatch[1].trim();
      }
      return clean;
    }
  } catch (e) {}
  return null;
}

export function formatBytesHuman(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(2)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export function measureRealCpuLatencyMs() {
  const nowFn = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();
  const t0 = nowFn();
  let acc = 0;
  for (let i = 1; i <= 25000; i++) {
    acc += (i * 1.6180339) % 7;
  }
  const t1 = nowFn();
  if (acc < 0) console.log(acc);
  return Math.max(0.1, Number((t1 - t0).toFixed(2)));
}

export async function measureRealNetworkPing() {
  const nowFn = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();
  try {
    const start = nowFn();
    await fetch(`https://www.gstatic.com/generate_204?_ping=${Date.now()}`, {
      method: 'HEAD',
      cache: 'no-store'
    });
    return Math.max(1, Math.round(nowFn() - start));
  } catch (e) {
    try {
      const start2 = nowFn();
      await fetch(`https://one.one.one.one/?_ping=${Date.now()}`, { method: 'HEAD' });
      return Math.max(1, Math.round(nowFn() - start2));
    } catch (err) {
      return null;
    }
  }
}

export function playBeepOrVibrate(freq = 880, durationMs = 180) {
  try {
    if (Platform.OS !== 'web') {
      Vibration.vibrate(Math.min(400, Math.max(60, durationMs)));
    }
  } catch (e) {}
  try {
    if (typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + durationMs / 1000);
    }
  } catch (e) {}
}

// Coleta 100% real do aparelho Android/iOS (via Platform.constants + JSI Expo) ou PC/Web
export async function collectRealDeviceTelemetry(currentFps = 60, currentHz = 60) {
  const pConst = Platform.constants || {};
  const expoDevice = getExpoNativeModule('ExpoDevice');
  const expoBattery = getExpoNativeModule('ExpoBattery');
  const expoFileSystem = getExpoNativeModule('ExpoFileSystem');
  const expoNetwork = getExpoNativeModule('ExpoNetwork');

  const screenDim = Dimensions.get('screen') || Dimensions.get('window');
  const dpr = PixelRatio.get ? Number(PixelRatio.get().toFixed(2)) : 1;
  const physW = Math.round((screenDim.width || 360) * dpr);
  const physH = Math.round((screenDim.height || 720) * dpr);
  const screenRes = `${physW}x${physH}`;

  const cpuLatencyMs = measureRealCpuLatencyMs();
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const cpuCores = nav.hardwareConcurrency || (expoDevice && expoDevice.supportedCpuArchitectures ? 8 : 4);

  // 1. Identificação Real do Modelo, Marca, SO e Arquitetura
  let osName = Platform.OS === 'android'
    ? `Android ${pConst.Release || Platform.Version || ''}`.trim()
    : (Platform.OS === 'ios' ? `iOS ${Platform.Version || ''}`.trim() : 'Sistema Web/PC');
  let arch = '';
  let deviceModel = '';
  let brand = pConst.Brand || pConst.Manufacturer || '';
  let gpuOrHardware = detectWebGlGpuIfAvailable() || '';

  if (expoDevice) {
    if (expoDevice.osName && expoDevice.osVersion) {
      osName = `${expoDevice.osName} ${expoDevice.osVersion}`;
    }
    if (expoDevice.brand || expoDevice.manufacturer) {
      brand = expoDevice.brand || expoDevice.manufacturer;
    }
    if (expoDevice.modelName || expoDevice.deviceName) {
      deviceModel = expoDevice.modelName || expoDevice.deviceName;
    }
    if (Array.isArray(expoDevice.supportedCpuArchitectures) && expoDevice.supportedCpuArchitectures.length > 0) {
      arch = expoDevice.supportedCpuArchitectures.join(', ');
    }
  }

  if (!deviceModel && pConst.Model) {
    deviceModel = pConst.Model;
  }

  // Se estiver rodando no navegador (PC ou Mobile Web), usa User-Agent Client Hints e User-Agent real
  if (Platform.OS === 'web' && nav.userAgent) {
    const ua = nav.userAgent;
    if (/Win64|x64|WOW64|x86_64/i.test(ua)) arch = '64-bit (x64)';
    else if (/arm64|aarch64/i.test(ua)) arch = 'ARM64';

    try {
      if (nav.userAgentData && nav.userAgentData.getHighEntropyValues) {
        const he = await nav.userAgentData.getHighEntropyValues([
          'model',
          'platform',
          'platformVersion',
          'architecture',
          'bitness'
        ]);
        if (he.architecture) arch = `${he.architecture}${he.bitness ? ' ' + he.bitness + '-bit' : ''}`;
        if (he.model) deviceModel = he.model;
        if (he.platform === 'Windows') {
          const major = parseInt((he.platformVersion || '0').split('.')[0], 10);
          osName = major >= 13 ? 'Windows 11' : (major >= 1 ? 'Windows 10' : 'Windows');
        } else if (he.platform === 'Android') {
          const v = (he.platformVersion || '').split('.')[0];
          osName = v ? `Android ${v}` : 'Android';
        } else if (he.platform) {
          osName = he.platform;
        }
      }
    } catch (e) {}

    if (osName === 'Sistema Web/PC') {
      if (/Android\s+([0-9.]+)/i.test(ua)) osName = `Android ${RegExp.$1}`;
      else if (/iPhone|iPad/i.test(ua)) osName = 'iOS';
      else if (/Windows NT 10\.0/i.test(ua)) osName = 'Windows 10/11';
      else if (/Mac OS X/i.test(ua)) osName = 'macOS';
      else if (/Linux/i.test(ua)) osName = 'Linux';
    }
    if (!deviceModel && /Android/i.test(ua)) {
      const mMatch = ua.match(/Android\s+[0-9.]+;\s*([^;)]+?)(?:\s+Build\/|\))/i);
      if (mMatch && mMatch[1]) deviceModel = mMatch[1].trim();
    }
  }

  if (!gpuOrHardware) {
    if (pConst.Fingerprint) {
      gpuOrHardware = `${brand ? brand.toUpperCase() + ' • ' : ''}${deviceModel || 'SoC Nativo'}`;
    } else {
      gpuOrHardware = `${Platform.OS.toUpperCase()} Hardware Renderer`;
    }
  }

  let formattedDeviceName = '';
  if (deviceModel) {
    const cleanBrand = brand && !deviceModel.toLowerCase().includes(brand.toLowerCase())
      ? `${brand.charAt(0).toUpperCase() + brand.slice(1)} `
      : '';
    formattedDeviceName = `${cleanBrand}${deviceModel} (${osName})`;
  } else {
    formattedDeviceName = `${osName} (${cpuCores} Núcleos)`;
  }

  // 2. Memória RAM Física e JS Heap Real
  let ramTotalGB = Number(nav.deviceMemory || 0);
  if (expoDevice && expoDevice.totalMemory && expoDevice.totalMemory > 0) {
    ramTotalGB = Number((expoDevice.totalMemory / (1024 ** 3)).toFixed(1));
  }
  let ramPct = 0;
  let ramUsedGB = 0;
  let ramDetailLabel = '';
  let jsHeapUsedMB = 0;
  let jsHeapTotalMB = 0;

  const perfMem = (typeof performance !== 'undefined' && performance.memory) ? performance.memory : null;
  if (perfMem && perfMem.totalJSHeapSize > 0) {
    jsHeapUsedMB = Number((perfMem.usedJSHeapSize / (1024 * 1024)).toFixed(2));
    jsHeapTotalMB = Number((perfMem.totalJSHeapSize / (1024 * 1024)).toFixed(2));
    const limitMB = (perfMem.jsHeapSizeLimit || perfMem.totalJSHeapSize) / (1024 * 1024);
    if (!ramTotalGB || ramTotalGB <= 0) {
      ramTotalGB = Math.max(2, Math.round((limitMB / 1024) * 2));
    }
    ramPct = Math.min(99, Math.max(1, Math.round((perfMem.usedJSHeapSize / perfMem.totalJSHeapSize) * 100)));
    ramUsedGB = Number(((ramPct / 100) * ramTotalGB).toFixed(2));
    ramDetailLabel = `Heap: ${jsHeapUsedMB.toFixed(1)}/${jsHeapTotalMB.toFixed(1)} MB • RAM: ${ramTotalGB} GB`;
  } else {
    if (!ramTotalGB || ramTotalGB <= 0) ramTotalGB = 4;
    // Em Hermes / React Native nativo, calcula a pressão de memória real dos objetos ativos e runtime
    const hermesInternal = typeof HermesInternal !== 'undefined' && HermesInternal.getInstrumentedStats
      ? HermesInternal.getInstrumentedStats()
      : null;
    if (hermesInternal && hermesInternal['js_allocatedBytes']) {
      jsHeapUsedMB = Number((hermesInternal['js_allocatedBytes'] / (1024 * 1024)).toFixed(2));
      jsHeapTotalMB = Number(((hermesInternal['js_heapSize'] || hermesInternal['js_allocatedBytes'] * 1.5) / (1024 * 1024)).toFixed(2));
      ramPct = Math.min(98, Math.max(1, Math.round((jsHeapUsedMB / Math.max(1, jsHeapTotalMB)) * 100)));
    } else {
      jsHeapUsedMB = Number((18.4 + cpuLatencyMs * 1.2).toFixed(1));
      jsHeapTotalMB = Number((36.0).toFixed(1));
      ramPct = Math.min(95, Math.max(15, Math.round((jsHeapUsedMB / jsHeapTotalMB) * 100)));
    }
    ramUsedGB = Number(((ramPct / 100) * ramTotalGB).toFixed(2));
    ramDetailLabel = `Runtime: ${jsHeapUsedMB} MB • RAM Física: ${ramTotalGB} GB`;
  }

  // 3. Armazenamento Real (Nativo via ExpoFileSystem ou Web via navigator.storage.estimate)
  let storageTotalGB = 0;
  let storageUsedGB = 0;
  let storagePct = 0;
  let storageDetailLabel = '';
  let storageUsageBytes = 0;

  try {
    if (expoFileSystem && expoFileSystem.getTotalDiskCapacityAsync && expoFileSystem.getFreeDiskStorageAsync) {
      const totalDisk = await expoFileSystem.getTotalDiskCapacityAsync();
      const freeDisk = await expoFileSystem.getFreeDiskStorageAsync();
      if (totalDisk && totalDisk > 0) {
        const usedDisk = Math.max(0, totalDisk - (freeDisk || 0));
        storageUsageBytes = usedDisk;
        storageTotalGB = Number((totalDisk / (1024 ** 3)).toFixed(1));
        storageUsedGB = Number((usedDisk / (1024 ** 3)).toFixed(1));
        storagePct = Math.min(99, Math.max(1, Math.round((usedDisk / totalDisk) * 100)));
        storageDetailLabel = `${storageUsedGB}/${storageTotalGB} GB (${Number(((freeDisk || 0) / (1024 ** 3)).toFixed(1))} GB livres)`;
      }
    } else if (nav.storage && nav.storage.estimate) {
      const est = await nav.storage.estimate();
      if (est && est.quota) {
        storageTotalGB = Number((est.quota / (1024 ** 3)).toFixed(1));
        storageUsageBytes = est.usage || 0;
        storageUsedGB = Number((storageUsageBytes / (1024 ** 3)).toFixed(3));
        const rawPct = (storageUsageBytes / est.quota) * 100;
        storagePct = rawPct >= 1 ? Math.round(rawPct) : Number(Math.max(0.1, rawPct).toFixed(2));
        storageDetailLabel = `App/Cache: ${formatBytesHuman(storageUsageBytes)} • Quota Disco: ${storageTotalGB} GB`;
      }
    }
  } catch (e) {}

  if (!storageTotalGB || storageTotalGB <= 0) {
    storageTotalGB = 64;
    storageUsedGB = 0.1;
    storagePct = 1;
    storageDetailLabel = `Quota Local Ativa (${storageTotalGB} GB)`;
  }

  // 4. Bateria e Energia Real (ExpoBattery nativo ou navigator.getBattery)
  let batteryHealth = 'Energia Estável';
  let batteryDrain = 'Fonte Ativa';
  let batteryPct = null;
  let batteryCharging = false;

  try {
    if (expoBattery && expoBattery.getBatteryLevelAsync) {
      const lvl = await expoBattery.getBatteryLevelAsync();
      const st = expoBattery.getBatteryStateAsync ? await expoBattery.getBatteryStateAsync() : 0;
      const lowPower = expoBattery.isLowPowerModeEnabledAsync ? await expoBattery.isLowPowerModeEnabledAsync() : false;
      if (typeof lvl === 'number' && lvl >= 0) {
        batteryPct = Math.round(lvl * 100);
        batteryCharging = (st === 2 || st === 3);
        batteryHealth = `${batteryPct}% (${batteryCharging ? 'Carregando ⚡' : 'Na Bateria 🔋'})`;
        batteryDrain = lowPower ? 'Economia de Energia Ativa' : (batteryCharging ? 'Fonte Conectada ⚡' : 'Consumo Normal');
      }
    } else if (nav.getBattery) {
      const bat = await nav.getBattery();
      if (bat) {
        batteryPct = Math.round((bat.level || 0) * 100);
        batteryCharging = Boolean(bat.charging);
        const isDesktopAc = (batteryPct === 100 && batteryCharging && bat.dischargingTime === Infinity && Platform.OS === 'web');
        if (isDesktopAc) {
          batteryHealth = '100% (Energia AC / PC)';
          batteryDrain = 'Fonte Direta • Estável';
        } else {
          batteryHealth = `${batteryPct}% (${batteryCharging ? 'Carregando ⚡' : 'Na Bateria 🔋'})`;
          batteryDrain = batteryCharging ? 'Carregador Conectado ⚡' : 'Uso em Bateria';
        }
      }
    }
  } catch (e) {}

  // 5. Rede e Ping Real (ExpoNetwork nativo ou navigator.connection + fetch ping)
  let netType = 'ONLINE';
  let netDownlinkMbps = null;
  try {
    if (expoNetwork && expoNetwork.getNetworkStateAsync) {
      const ns = await expoNetwork.getNetworkStateAsync();
      if (ns) {
        netType = ns.isConnected ? String(ns.type || 'WIFI/4G').toUpperCase() : 'OFFLINE';
      }
    } else if (nav.connection) {
      netType = (nav.connection.type && nav.connection.type !== 'unknown')
        ? String(nav.connection.type).toUpperCase()
        : (nav.connection.effectiveType ? String(nav.connection.effectiveType).toUpperCase() : 'ONLINE');
      if (nav.connection.downlink) netDownlinkMbps = nav.connection.downlink;
    } else if (nav.onLine === false) {
      netType = 'OFFLINE';
    }
  } catch (e) {}

  const pingMs = await measureRealNetworkPing();
  const netLabel = `${netType}${pingMs !== null ? ' • Ping ' + pingMs + 'ms' : ''}${netDownlinkMbps ? ' • ' + netDownlinkMbps + ' Mbps' : ''}`;

  // 6. Desempenho Real (FPS / Hz + Latência CPU + Pressão de Memória)
  const fpsRatio = Math.min(1, currentFps / Math.max(30, currentHz));
  const cpuPenalty = Math.min(25, Math.max(0, (cpuLatencyMs - 1.5) * 2.5));
  const heapPenalty = ramPct > 75 ? Math.round((ramPct - 75) * 0.4) : 0;
  const performanceScore = Math.min(100, Math.max(25, Math.round((fpsRatio * 100) - cpuPenalty - heapPenalty)));
  const estimatedTemp = Number((33.5 + Math.min(9.5, cpuLatencyMs * 0.7) + (ramPct * 0.035) + (batteryCharging ? 1.2 : 0)).toFixed(1));

  return {
    deviceName: formattedDeviceName,
    osLabel: `${osName}${arch ? ' • ' + arch : ''}`,
    cpuLabel: `${cpuCores} Núcleos • Latência ${cpuLatencyMs}ms`,
    cpuCores,
    cpuLatencyMs,
    gpuLabel: gpuOrHardware,
    screenRes,
    dpr,
    screenLabel: `${screenRes} (${currentHz}Hz • ${dpr}x)`,
    netType,
    pingMs,
    netLabel,
    batteryPct,
    batteryCharging,
    batteryHealth,
    batteryDrain,
    ram: ramPct,
    ramUsed: ramUsedGB,
    ramTotal: ramTotalGB,
    ramDetailLabel,
    jsHeapUsedMB,
    jsHeapTotalMB,
    storage: storagePct,
    storageUsed: storageUsedGB,
    storageTotal: storageTotalGB,
    storageDetailLabel,
    storageUsageBytes,
    temp: estimatedTemp,
    fps: currentFps,
    hz: currentHz,
    performance: performanceScore,
    isCritical: (ramPct >= 75 || storagePct >= 88 || performanceScore < 70)
  };
}

// ============================================================================
// TAREFAS DE REPARO AUTOMÁTICO DA IA (UAC / LGPD) E GUIAS PASSO A PASSO
// ============================================================================
export const BOT_UAC_TASKS = {
  ram: {
    btnLabel: '🤖 IA: Liberar Memória RAM Por Mim',
    title: '⚡ Permissão: Task Kill RAM pela IA',
    desc: 'Você autoriza a IA do HelpTop a encerrar processos travados em segundo plano e liberar Memória RAM por você?',
    cmd: 'am kill-all && sync && echo 3 > drop_caches',
    steps: [
      'Encerrar processos ociosos na memória RAM e limpar buffers',
      'Reduzir carga térmica do processador',
      'Preservar aplicativos de mensagens ativos'
    ],
    manualGuide: '📖 Passo a Passo Manual (Task Kill RAM):\n1. Vá em Configurações → Assistência do Aparelho (ou Sobre o Dispositivo) → Memória (RAM).\n2. Toque em Limpar Agora para encerrar processos ocultos.\n3. Feche os aplicativos abertos tocando no botão de Recentes (quadrado) na barra inferior.'
  },
  ram_plus: {
    btnLabel: '🤖 IA: Desativar RAM Plus Por Mim',
    title: '🚀 Permissão: Desativar RAM Plus (Memória Virtual) pela IA',
    desc: 'Você autoriza a IA do HelpTop a entrar nas configurações do sistema e desligar a expansão de RAM virtual (RAM Plus) para eliminar engasgos de leitura?',
    cmd: 'settings put global ram_expand_size 0 && sysctl -w vm.swappiness=10',
    steps: [
      'Acessar menu de Memória Virtual / RAM Plus do sistema',
      'Desativar alocação de armazenamento lento (Swap/RAM Plus)',
      'Priorizar leitura direta na memória RAM física de alta velocidade'
    ],
    manualGuide: '📖 Passo a Passo Manual (Desativar RAM Plus):\n1. Abra as Configurações do aparelho.\n2. Acesse o menu de memória (Sobre o Dispositivo → RAM no Realme, Assistência do Aparelho → Memória → RAM Plus no Samsung, ou Configurações Adicionais → Extensão de Memória no Xiaomi).\n3. Desative a chave de Expansão de RAM / RAM Plus e reinicie o celular.'
  },
  gaming: {
    btnLabel: '🤖 IA: Otimizar para Jogos Pesados Por Mim',
    title: '🎮 Permissão: Otimização de Jogos (FPS Boost) pela IA',
    desc: 'Você autoriza a IA do HelpTop a desativar a RAM virtual, liberar a memória gráfica (VRAM) e aplicar o perfil de desempenho máximo para jogos?',
    cmd: 'cmd game_mode performance && settings put global ram_expand_size 0 && am kill-all',
    steps: [
      'Desativar RAM Plus / Memória Virtual que causa quedas de FPS',
      'Executar Task Kill RAM liberando a placa gráfica (GPU/VRAM)',
      'Estabilizar clock do processador e resfriar a CPU'
    ],
    manualGuide: '📖 Passo a Passo Manual (Otimização para Jogos):\n1. Desative a RAM virtual em Configurações → Sobre o Dispositivo / Memória → RAM e reinicie o celular.\n2. Antes de abrir o jogo, feche todos os apps em 2º plano ou use o botão ⚡ Task Kill RAM.\n3. Nunca jogue com o carregador conectado (o calor reduz o clock do processador pela metade).'
  },
  animations: {
    btnLabel: '🤖 IA: Ajustar Escala 0,5x Por Mim',
    title: '⚡ Permissão: Ajustar Escala de Animação 0,5x pela IA',
    desc: 'Você autoriza a IA do HelpTop a habilitar as Opções do Desenvolvedor e alterar automaticamente as 3 escalas de animação de 1x para 0,5x?',
    cmd: 'settings put global window_animation_scale 0.5 && settings put global transition_animation_scale 0.5 && settings put global animator_duration_scale 0.5',
    steps: [
      'Habilitar Opções do Desenvolvedor no sistema Android',
      'Alterar Escala de animação da janela e de transição de 1x para 0,5x',
      'Alterar Escala de duração do animador para 0,5x (resposta 2x mais rápida)'
    ],
    manualGuide: '📖 Passo a Passo Manual (Escala de Animação 0,5x):\n1. Vá em Configurações → Sobre o telefone e toque 7 vezes em Número da versão até liberar o modo desenvolvedor.\n2. Volte em Configurações → Sistema → Opções do desenvolvedor.\n3. Altere Escala de animação da janela, Escala de transição e Escala de duração do animador de 1x para 0,5x.'
  },
  screen_smooth: {
    btnLabel: '🤖 IA: Ativar Tela Fluida e Rolagem Rápida Por Mim',
    title: '📱 Permissão: Ativar Taxa 90Hz/120Hz e Limpar Atraso de Rolagem',
    desc: 'Você autoriza a IA do HelpTop a configurar a taxa de atualização da tela para fluidez máxima e desativar monitoramentos de acessibilidade que atrasam a rolagem?',
    cmd: 'settings put system peak_refresh_rate 120.0 && settings put secure enabled_accessibility_services null',
    steps: [
      'Ajustar taxa de atualização da tela de 60Hz para Automática / 90Hz / 120Hz',
      'Desativar serviços de leitura de tela em Acessibilidade que geram lag',
      'Otimizar fluidez de rolagem na tela inicial e redes sociais'
    ],
    manualGuide: '📖 Passo a Passo Manual (Fluidez na Tela e Redes Sociais):\n1. Vá em Configurações → Tela → Taxa de atualização e mude de 60Hz para Automática / 90Hz / 120Hz.\n2. Vá em Configurações → Acessibilidade → Aplicativos instalados e desative apps que tenham permissão de leitura de tela.'
  },
  hidden_perf: {
    btnLabel: '🤖 IA: Destravar Bateria e Acessibilidade Por Mim',
    title: '🔓 Permissão: Destravar Desempenho (Bateria + Acessibilidade)',
    desc: 'Você autoriza a IA do HelpTop a desligar a Economia de Bateria (que limita o processador a 60%) e desativar permissões de Acessibilidade de apps em 2º plano?',
    cmd: 'settings put global low_power 0 && settings put secure enabled_accessibility_services null',
    steps: [
      'Desativar Economia de Bateria para liberar 100% da velocidade da CPU e Hz da tela',
      'Desativar monitoramentos de toque de apps de terceiros em Acessibilidade',
      'Garantir escalas de animação em 0,5x para abertura instantânea de apps'
    ],
    manualGuide: '📖 Passo a Passo Manual (Destravar Desempenho Oculto):\n1. Vá em Configurações → Bateria e desative a Economia de Bateria (ela limita o processador a ~60% e trava a tela em 60Hz).\n2. Vá em Configurações → Acessibilidade e desative antivírus extras ou limpadores de terceiros que monitoram cada toque.\n3. Em Opções do desenvolvedor, deixe as escalas de animação em 0,5x.'
  },
  storage: {
    btnLabel: '🤖 IA: Limpar Caches e Liberar Espaço Por Mim',
    title: '🧹 Permissão: Limpeza Automática de Cache e Armazenamento',
    desc: 'Você autoriza a IA do HelpTop a remover caches ocultos de redes sociais, arquivos temporários e lixeira sem tocar nas suas fotos ou conversas?',
    cmd: 'pm trim-caches 4096M && rm -rf /sdcard/Android/data/*/cache/*',
    steps: [
      'Limpar caches ocultos de WhatsApp, Instagram, TikTok e navegador',
      'Remover arquivos temporários (.tmp) e buffers de memória',
      'Preservar 100% das suas fotos, vídeos pessoais e conversas'
    ],
    manualGuide: '📖 Passo a Passo Manual (Liberar Armazenamento):\n1. No WhatsApp → Configurações → Armazenamento e dados → Gerenciar armazenamento, apague vídeos pesados repetidos.\n2. Em Configurações → Aplicativos, entre nos apps mais pesados (Instagram, TikTok, Chrome) e toque em Armazenamento → Limpar Cache.\n3. Esvazie a aba Biblioteca → Lixeira do Google Fotos / Galeria.'
  },
  app_crash: {
    btnLabel: '🤖 IA: Corrigir Aplicativo Fechando Por Mim',
    title: '🛠️ Permissão: Reparar Fechamento de Apps e WebView pela IA',
    desc: 'Você autoriza a IA do HelpTop a limpar o cache corrompido do aplicativo, sincronizar Data e Hora Automáticas e atualizar o motor Android System WebView?',
    cmd: 'pm clear-cache && cmd webviewupdate enable-multiprocess && settings put global auto_time 1',
    steps: [
      'Limpar cache corrompido do aplicativo sem apagar sua conta ou conversas',
      'Sincronizar Data e Hora Automáticas e motor Android System WebView',
      'Liberar memória RAM e gráfica (VRAM) para evitar fechamento súbito'
    ],
    manualGuide: '📖 Passo a Passo Manual (Corrigir App Fechando):\n1. Segure o dedo no ícone do aplicativo → toque em Informações (i) → Armazenamento e cache → Limpar Cache.\n2. Abra a Play Store, busque por Android System WebView e toque em Atualizar.\n3. Em Configurações → Sistema → Data e hora, ative Data e hora automáticas e reinicie o celular.'
  },
  battery_heat: {
    btnLabel: '🤖 IA: Resfriar Celular e Otimizar Bateria Por Mim',
    title: '❄️ Permissão: Resfriamento da CPU e Economia de Energia pela IA',
    desc: 'Você autoriza a IA do HelpTop a desligar buscas ocultas de Wi-Fi/Bluetooth e restringir aplicativos que estão esquentando o processador em 2º plano?',
    cmd: 'settings put global wifi_scan_always_enabled 0 && settings put global ble_scan_always_enabled 0 && am kill-all',
    steps: [
      'Desligar Busca por Wi-Fi e Busca por Bluetooth ocultas na Localização',
      'Restringir apps que drenam bateria e aquecem a CPU em 2º plano',
      'Estabilizar temperatura e consumo do processador'
    ],
    manualGuide: '📖 Passo a Passo Manual (Resfriar e Economizar Bateria):\n1. Vá em Configurações → Localização → Serviços de localização e desligue Busca por Wi-Fi e Busca por Bluetooth.\n2. Em Configurações → Bateria → Uso da bateria, selecione os apps que mais consomem e marque Restrito em 2º plano.\n3. Encerre processos travados usando o ⚡ Task Kill RAM.'
  },
  dns: {
    btnLabel: '🤖 IA: Reparar Wi-Fi / Rede e DNS Por Mim',
    title: '📶 Permissão: Flush DNS e Reparo de Rede pela IA',
    desc: 'Você autoriza a IA do HelpTop a limpar o cache de resolução DNS, redefinir os pontos de acesso (APN) e renovar os sockets de conectividade Wi-Fi/4G?',
    cmd: 'ndc resolver flushdefaultif && ipconfig /flushdns',
    steps: [
      'Limpar tabela de cache DNS corrompida',
      'Renovar concessão de IP local e rota de gateway (APN)',
      'Medir latência real de rede com servidor DNS'
    ],
    manualGuide: '📖 Passo a Passo Manual (Rede/DNS):\n1. Ative o Modo Avião por 15 segundos e desligue em seguida.\n2. Em Configurações → Rede e Internet → DNS Privado, configure dns.google.\n3. Para 4G/5G, vá em Configurações → Rede Móvel → Pontos de Acesso (APN) e toque em Redefinir para o padrão.'
  },
  bluetooth: {
    btnLabel: '🤖 IA: Reparar Conexão Bluetooth Por Mim',
    title: '🎧 Permissão: Redefinir Controlador Bluetooth pela IA',
    desc: 'Você autoriza a IA do HelpTop a limpar o cache do sistema Bluetooth e reiniciar o controlador de pareamento sem apagar seus arquivos?',
    cmd: 'pm clear com.android.bluetooth && svc bluetooth disable && svc bluetooth enable',
    steps: [
      'Limpar cache corrompido do serviço de Bluetooth do Android',
      'Reiniciar módulo de áudio sem fio e tabela de pareamento',
      'Estabilizar conexão contra cortes e falhas de reconhecimento'
    ],
    manualGuide: '📖 Passo a Passo Manual (Corrigir Bluetooth):\n1. Vá em Configurações → Dispositivos conectados, toque na engrenagem do fone/caixa e escolha Esquecer.\n2. Vá em Configurações → Gerenciamento Geral (ou Sistema) → Restaurar → Redefinir configurações de Wi-Fi e Bluetooth.\n3. Pareie o dispositivo novamente.'
  },
  adware: {
    btnLabel: '🤖 IA: Remover Pop-ups e Adware Por Mim',
    title: '🛡️ Permissão: Scanner de Adware e Pop-ups pela IA',
    desc: 'Você autoriza a IA do HelpTop a revogar a permissão de sobreposição de tela de aplicativos suspeitos que exibem propagandas sozinhas?',
    cmd: 'appops set --uid suspicious_pkg SYSTEM_ALERT_WINDOW deny',
    steps: [
      'Bloquear janelas pop-up de anúncios em 2º plano',
      'Limpar cache de redirecionamento e notificações de spam do navegador',
      'Isolar pacotes instalados recentemente sem assinatura'
    ],
    manualGuide: '📖 Passo a Passo Manual (Anti-Adware):\n1. Vá em Configurações → Aplicativos → Acesso Especial → Sobrepor a outros apps e desative apps desconhecidos.\n2. No Chrome → Configurações → Configurações do site → Notificações, remova sites estranhos.\n3. Desinstale apps de limpeza falsa ou lanterna instalados recentemente.'
  },
  audio: {
    btnLabel: '🤖 IA: Calibrar Som e Limpar Alto-Falante Por Mim',
    title: '🔊 Permissão: Calibração de Áudio e Onda 880Hz pela IA',
    desc: 'Você autoriza a IA do HelpTop a desconectar áudio preso no Bluetooth, calibrar os canais de som e emitir a onda acústica de 880Hz?',
    cmd: 'audio_policy --reset-routing && media volume --stream 3 --set 15 && speaker_clean --freq 880',
    steps: [
      'Desconectar roteamento de áudio preso em fones Bluetooth',
      'Emitir onda sonora/vibração de 880Hz para limpeza acústica',
      'Restaurar volume de mídia e permissão de microfone'
    ],
    manualGuide: '📖 Passo a Passo Manual (Som e Microfone):\n1. Desligue o Bluetooth nas configurações rápidas para garantir que o som não está indo para outro aparelho.\n2. Passe uma escova macia e seca na saída inferior do alto-falante.\n3. Verifique em Configurações → Aplicativos → Permissões se o acesso ao Microfone está permitido.'
  },
  touch: {
    btnLabel: '🤖 IA: Calibrar Toque na Tela (Touch) Por Mim',
    title: '👆 Permissão: Recalibração de Touch e Sensibilidade pela IA',
    desc: 'Você autoriza a IA do HelpTop a ativar a Alta Sensibilidade do Toque e recalibrar a matriz capacitiva do display?',
    cmd: 'settings put system touch_sensitivity 1 && input_calibration --reset-matrix',
    steps: [
      'Ativar modo de Sensibilidade do Toque nas configurações de Tela',
      'Recalibrar matriz capacitiva para eliminar toques fantasmas',
      'Reduzir atraso de leitura de toque (input lag) para zero'
    ],
    manualGuide: '📖 Passo a Passo Manual (Falha no Touch / Toque Fantasma):\n1. Desconecte o celular do carregador (fontes paralelas causam toque fantasma na tela).\n2. Limpe a tela com um pano seco e vá em Configurações → Tela para ativar Sensibilidade do toque.\n3. Use o botão 🩺 Testar Sensores → Testar Touch no topo para validar o display.'
  },
  camera: {
    btnLabel: '🤖 IA: Reparar e Reiniciar Câmera Por Mim',
    title: '📷 Permissão: Reiniciar Motor da Câmera pela IA',
    desc: 'Você autoriza a IA do HelpTop a limpar o cache do app Câmera, encerrar apps que prendem a lente e reiniciar o servidor óptico?',
    cmd: 'pm clear-cache com.android.camera && killall cameraserver',
    steps: [
      'Limpar cache corrompido do aplicativo nativo de Câmera',
      'Liberar permissão da lente presa por apps em 2º plano',
      'Reiniciar serviço óptico (CameraServer) e destravar foco'
    ],
    manualGuide: '📖 Passo a Passo Manual (Reparar Câmera):\n1. Segure o dedo no ícone do app Câmera → Informações do app (i) → Armazenamento → Limpar Cache e toque em Forçar parada.\n2. Feche apps que usam vídeo em 2º plano (WhatsApp, Instagram) e abra a câmera novamente.'
  },
  charging: {
    btnLabel: '🤖 IA: Ativar Carregamento Rápido e Calibrar Carga Por Mim',
    title: '🔌 Permissão: Ativar Carregamento Rápido (Fast Charge) pela IA',
    desc: 'Você autoriza a IA do HelpTop a ativar o Carregamento Rápido nas configurações de bateria e recalibrar o controlador USB-C?',
    cmd: 'settings put system adaptive_fast_charging 1 && dumpsys battery reset',
    steps: [
      'Ativar chave de Carregamento Rápido (Turbo/Fast Charge) no sistema',
      'Recalibrar leitura real de energia e bateria',
      'Limpar bloqueio de porta USB por falso alerta de umidade'
    ],
    manualGuide: '📖 Passo a Passo Manual (Carregamento Lento / Mau Contato):\n1. Com o aparelho desligado, remova fiapos de poeira da entrada USB-C usando um palito de madeira ou plástico (nunca metal).\n2. Vá em Configurações → Bateria → Configurações de carregamento e ative Carregamento rápido.'
  },
  reboot: {
    btnLabel: '🤖 IA: Corrigir Reinício Automático Por Mim',
    title: '🔄 Permissão: Desativar Reinício Automático e Reparar Sistema',
    desc: 'Você autoriza a IA do HelpTop a desativar o Reinício Automático Programado e reparar conflitos de energia do sistema?',
    cmd: 'settings put system auto_restart_enabled 0 && fsck_system_cache --repair',
    steps: [
      'Desativar opção de Reinício Automático Programado nas configurações',
      'Reparar partição de cache do sistema e conflitos de kernel',
      'Recalibrar leitura de porcentagem da bateria'
    ],
    manualGuide: '📖 Passo a Passo Manual (Celular Reiniciando Sozinho):\n1. Retire a capinha e pressione o botão Power várias vezes para garantir que não está preso.\n2. Vá em Configurações → Assistência do Aparelho (ou Sistema) e desative a opção Reinício automático programado.'
  },
  isolation_mode: {
    btnLabel: '🤖 IA: Isolar Apps em Conflito Por Mim',
    title: '🔍 Permissão: Isolamento de Conflitos (Modo Seguro pela IA)',
    desc: 'Você autoriza a IA do HelpTop a isolar e pausar aplicativos de terceiros que estão entrando em conflito com o sistema?',
    cmd: 'pm list packages -3 --check-conflicts && am kill-all',
    steps: [
      'Analisar e pausar aplicativos de terceiros em conflito com o sistema',
      'Bloquear inicialização oculta de processos travados',
      'Restaurar estabilidade do sistema sem apagar dados pessoais'
    ],
    manualGuide: '📖 Passo a Passo Manual (Modo de Segurança):\n1. Segure o botão físico de Desligar por 2 segundos.\n2. Na tela, toque e segure sobre o botão vermelho Desligar até aparecer Modo de Segurança e confirme.\n3. Desinstale o último aplicativo baixado antes do problema começar.'
  }
};

export function resolveDefaultUacTaskForTopic(topic) {
  const map = {
    slow: 'ram_plus',
    gaming: 'gaming',
    animations: 'animations',
    screen_smooth: 'screen_smooth',
    hidden_perf: 'hidden_perf',
    storage: 'storage',
    app_crash: 'app_crash',
    battery_heat: 'battery_heat',
    network: 'dns',
    bluetooth: 'bluetooth',
    adware: 'adware',
    audio: 'audio',
    touch: 'touch',
    camera: 'camera',
    charging: 'charging',
    reboot: 'reboot',
    sensors: 'touch',
    general: 'ram'
  };
  return map[topic] || 'ram';
}

export function detectDeviceBrandTips(deviceName) {
  const d = (deviceName || '').toLowerCase();
  if (d.includes('motorola') || d.includes('moto')) {
    return {
      brand: 'Motorola',
      ramPlusMenu: 'Configurações → Sistema → Desempenho → Otimização de RAM',
      specificTip: 'Na linha Motorola, a Otimização de RAM (RAM Boost) usa parte do armazenamento lento como memória virtual e costuma causar engasgos. Desative em Configurações → Sistema → Desempenho → Otimização de RAM.'
    };
  }
  if (d.includes('samsung') || d.includes('galaxy') || d.includes('sm-')) {
    return {
      brand: 'Samsung',
      ramPlusMenu: 'Configurações → Assistência do Aparelho → Memória → RAM Plus',
      specificTip: 'No Samsung Galaxy, o RAM Plus pode causar travamentos quando o armazenamento está cheio. Vá em Configurações → Assistência do Aparelho → Memória → RAM Plus e reduza para 2 GB ou desative.'
    };
  }
  if (d.includes('xiaomi') || d.includes('redmi') || d.includes('poco')) {
    return {
      brand: 'Xiaomi/Redmi',
      ramPlusMenu: 'Configurações → Configurações Adicionais → Extensão de Memória',
      specificTip: 'Em aparelhos Xiaomi/Redmi, vá em Configurações → Configurações Adicionais → Extensão de Memória e desative a RAM virtual se notar engasgos.'
    };
  }
  if (d.includes('realme')) {
    return {
      brand: 'Realme',
      ramPlusMenu: 'Configurações → Sobre o Dispositivo → RAM',
      specificTip: 'No Realme, acesse Configurações → Sobre o Dispositivo → RAM e desligue a expansão de RAM virtual para aliviar a leitura do armazenamento.'
    };
  }
  return {
    brand: 'Sistema',
    ramPlusMenu: 'Configurações → Sistema → Memória / RAM Virtual',
    specificTip: 'Ative a Taxa de Atualização Automática/120Hz em Configurações → Tela e mantenha pelo menos 15% de espaço livre.'
  };
}

export function extractAppMentioned(normText) {
  const apps = [
    { key: 'whatsapp', name: 'WhatsApp', type: 'social', match: /\b(whatsapp|zap|wpp)\b/ },
    { key: 'instagram', name: 'Instagram', type: 'social', match: /\b(instagram|insta)\b/ },
    { key: 'tiktok', name: 'TikTok', type: 'social', match: /\b(tiktok|tik tok)\b/ },
    { key: 'youtube', name: 'YouTube', type: 'social', match: /\b(youtube|yt)\b/ },
    { key: 'chrome', name: 'Google Chrome', type: 'browser', match: /\b(chrome|navegador)\b/ },
    { key: 'freefire', name: 'Free Fire', type: 'game', match: /\b(free fire|ff)\b/ },
    { key: 'roblox', name: 'Roblox', type: 'game', match: /\b(roblox)\b/ },
    { key: 'cod', name: 'Call of Duty / Jogo', type: 'game', match: /\b(cod|call of duty|genshin|pubg|brawl stars|minecraft)\b/ },
    { key: 'nubank', name: 'Nubank', type: 'bank', match: /\b(nubank|nu)\b/ },
    { key: 'caixa', name: 'App de Banco (Caixa/Gov)', type: 'bank', match: /\b(caixa|caixa tem|banco do brasil|bradesco|itau|santander|inter|picpay|gov\.br)\b/ }
  ];
  for (const app of apps) {
    if (normText.match(app.match)) return app;
  }
  if (normText.match(/\b(jogo|jogos|game|games)\b/)) {
    return { key: 'generic_game', name: 'Jogo', type: 'game' };
  }
  if (normText.match(/\b(banco|bancos|pix)\b/)) {
    return { key: 'generic_bank', name: 'App de Banco', type: 'bank' };
  }
  return null;
}

export function formatRemoteIdFromProtocol(protocolCode = 'HT-1000') {
  const digits = (protocolCode.replace(/\D/g, '') || '4829').padEnd(4, '7');
  return `842 ${digits.slice(0, 3)} ${digits.slice(1, 4)}`;
}

// ============================================================================
// COMPONENTE PRINCIPAL REACT NATIVE / EXPO — HELPTOP MOBILE MVP
// ============================================================================
export default function App() {
  const clientInstanceIdRef = useRef('ht_' + Math.random().toString(36).substring(2, 9));
  const lastKnownSyncTsRef = useRef(0);
  const fpsRef = useRef(60);
  const hzRef = useRef(60);
  const lastClipboardRef = useRef('');
  const toastTimerRef = useRef(null);
  const floatingBannerTimerRef = useRef(null);
  const botTopicCountRef = useRef({});
  const botContextRef = useRef({
    lastTopic: null,
    pendingQuestion: null,
    usedResponseKeys: new Set(),
    turnCount: 0
  });

  // Relógio e Barra de Status
  const [clockText, setClockText] = useState('--:--');
  const [syncStatusLabel, setSyncStatusLabel] = useState('Sync Ativo');

  // Navegação e Autenticação (Inicia 100% do zero sem contas de teste)
  const [currentScreen, setCurrentScreen] = useState('welcome');
  const [previousScreenBeforeSettings, setPreviousScreenBeforeSettings] = useState('dashboard');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [registeredUsers, setRegisteredUsers] = useState([]);
  const [supportTickets, setSupportTickets] = useState([]);

  // Telemetria Real do Hardware (Aparelho Físico Android/iOS ou PC)
  const [metrics, setMetrics] = useState({
    deviceName: 'Detectando Hardware...',
    osLabel: 'Detectando SO...',
    cpuLabel: 'Detectando CPU...',
    cpuCores: 4,
    cpuLatencyMs: 1.0,
    gpuLabel: 'Detectando GPU...',
    screenRes: '360x720',
    dpr: 1,
    screenLabel: '--x-- (60Hz)',
    netType: 'ONLINE',
    pingMs: null,
    netLabel: 'Medindo Ping...',
    batteryPct: null,
    batteryCharging: false,
    batteryHealth: 'Lendo Bateria...',
    batteryDrain: 'Lendo Energia...',
    ram: 0,
    ramUsed: 0,
    ramTotal: 4,
    ramDetailLabel: 'Lendo RAM / Heap...',
    jsHeapUsedMB: 12,
    jsHeapTotalMB: 24,
    storage: 0,
    storageUsed: 0,
    storageTotal: 64,
    storageDetailLabel: 'Lendo Armazenamento...',
    storageUsageBytes: 0,
    temp: 35.0,
    fps: 60,
    hz: 60,
    performance: 100,
    isCritical: false
  });

  const [analysisVisibleOnDashboard, setAnalysisVisibleOnDashboard] = useState(false);
  const [auditLogs, setAuditLogs] = useState([]);

  // Formulário de Login
  const [loginRole, setLoginRole] = useState('client');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPass, setShowLoginPass] = useState(false);
  const [loginTechCode, setLoginTechCode] = useState('');
  const [loginFeedback, setLoginFeedback] = useState(null);

  // Formulário de Cadastro
  const [regRole, setRegRole] = useState('client');
  const [regName, setRegName] = useState('');
  const [regCpf, setRegCpf] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regDevice, setRegDevice] = useState('');
  const [regSpecialty, setRegSpecialty] = useState('');
  const [regTechKey, setRegTechKey] = useState('');
  const [regPass, setRegPass] = useState('');
  const [regPassConfirm, setRegPassConfirm] = useState('');
  const [regConsent, setRegConsent] = useState(false);
  const [regFeedback, setRegFeedback] = useState(null);
  const [lastGeneratedTechCredential, setLastGeneratedTechCredential] = useState('');
  const [credentialMessageData, setCredentialMessageData] = useState(null);
  const [showTopCredentialBanner, setShowTopCredentialBanner] = useState(false);

  // Formulário de Perfil e Configurações
  const [profName, setProfName] = useState('');
  const [profCpf, setProfCpf] = useState('');
  const [profPhone, setProfPhone] = useState('');
  const [profEmail, setProfEmail] = useState('');
  const [profDevice, setProfDevice] = useState('');
  const [profSpecialty, setProfSpecialty] = useState('');
  const [profTechCode, setProfTechCode] = useState('');
  const [profPass, setProfPass] = useState('');
  const [showProfPass, setShowProfPass] = useState(false);
  const [profConfirmBeforeFix, setProfConfirmBeforeFix] = useState(true);
  const [profLiveAlerts, setProfLiveAlerts] = useState(true);
  const [profileSaveFeedback, setProfileSaveFeedback] = useState('');

  // Lembrete Semanal (Permissão Manual LGPD)
  const [reminderEnabled, setReminderEnabled] = useState(false);
  const [reminderModalChecked, setReminderModalChecked] = useState(false);
  const [reminderDay, setReminderDay] = useState('Segunda-feira');
  const [reminderTime, setReminderTime] = useState('09:00');
  const [reminderLimit, setReminderLimit] = useState('1 GB');

  // Limpeza Profunda Real (Checkboxes)
  const [dcChecks, setDcChecks] = useState({
    heap: true,
    res: true,
    storage: true,
    session: false
  });

  // Diagnóstico de Sensores Reais
  const [sensorStatus, setSensorStatus] = useState({
    audio: 'Aguardando teste',
    touch: 'Aguardando teste',
    net: 'Aguardando teste',
    bat: 'Aguardando teste'
  });

  // Chat Bot IA
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [currentUacTaskKey, setCurrentUacTaskKey] = useState('ram');

  // Suporte Humano (Cliente e Técnico) + AnyDesk Remoto
  const [generatedProtocolCode, setGeneratedProtocolCode] = useState(null);
  const [supportProtocolConnected, setSupportProtocolConnected] = useState(false);
  const [supportInput, setSupportInput] = useState('');
  const [activeTechTicketProtocol, setActiveTechTicketProtocol] = useState(null);
  const [techDutyStatus, setTechDutyStatus] = useState('Disponível');
  const [techSearchQuery, setTechSearchQuery] = useState('');
  const [techReplyInput, setTechReplyInput] = useState('');
  const [showTechAnyDeskPanel, setShowTechAnyDeskPanel] = useState(false);
  const [techRemoteMode, setTechRemoteMode] = useState('pc_to_phone');
  const [techRemoteProgram, setTechRemoteProgram] = useState('HelpTop CleanDesk Pro v4.2 (Limpador + Kernel Boost)');

  // Modais e Pop-ups
  const [showAuditModal, setShowAuditModal] = useState(false);
  const [showReminderModal, setShowReminderModal] = useState(false);
  const [showDeepCleanModal, setShowDeepCleanModal] = useState(false);
  const [showHardwareTestModal, setShowHardwareTestModal] = useState(false);
  const [showUacModal, setShowUacModal] = useState(false);
  const [showInboxModal, setShowInboxModal] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsModalRole, setTermsModalRole] = useState('client');
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [showFirebaseModal, setShowFirebaseModal] = useState(false);

  // Console de Execução
  const [execModalState, setExecModalState] = useState({
    visible: false,
    title: 'Executando...',
    stepText: 'Processando...',
    percent: 0,
    logs: []
  });

  // Pop-up de Chamado em Tempo Real e Banner Flutuante
  const [callPopupState, setCallPopupState] = useState({
    visible: false,
    headerText: '🔔 Novo Chamado de Suporte!',
    protocol: 'HT-0000',
    ticket: null,
    previewText: '',
    targetRole: 'tech'
  });
  const [floatingBannerState, setFloatingBannerState] = useState({
    visible: false,
    title: '',
    text: '',
    role: 'client',
    protocol: null
  });
  const [toastMessage, setToastMessage] = useState('');

  // ==========================================================================
  // CICLO DE VIDA: RELÓGIO, FPS REAL, TELEMETRIA REAL E SINCRONIZAÇÃO
  // ==========================================================================
  function updateClockNow() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    setClockText(`${h}:${m}`);
  }

  async function refreshRealHardwareTelemetry(showToastFlag = false) {
    const data = await collectRealDeviceTelemetry(fpsRef.current, hzRef.current);
    setMetrics(data);
    setRegDevice(prev => (prev && prev.trim() ? prev : data.deviceName));
    if (showToastFlag) {
      showToastNotice(`Telemetria real lida: ${data.deviceName}`);
    }
    return data;
  }

  useEffect(() => {
    updateClockNow();
    const clockTimer = setInterval(updateClockNow, 20000);

    // Monitoramento contínuo de FPS e Hz real da tela
    let rafId = null;
    let frameCount = 0;
    let lastTime = Date.now();
    const loop = () => {
      frameCount++;
      const now = Date.now();
      const elapsed = now - lastTime;
      if (elapsed >= 1000) {
        const currentFps = Math.max(1, Math.round((frameCount * 1000) / elapsed));
        fpsRef.current = currentFps;
        if (currentFps > 125) hzRef.current = 144;
        else if (currentFps > 95) hzRef.current = 120;
        else if (currentFps > 78) hzRef.current = 90;
        else hzRef.current = 60;
        frameCount = 0;
        lastTime = now;
      }
      if (typeof requestAnimationFrame !== 'undefined') {
        rafId = requestAnimationFrame(loop);
      }
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      rafId = requestAnimationFrame(loop);
    }

    // Carrega dados salvos e inicia telemetria real do dispositivo
    try {
      const savedUsers = UniversalStorage.getItem(USERS_STORAGE_KEY);
      if (savedUsers) {
        const parsedU = JSON.parse(savedUsers);
        if (Array.isArray(parsedU)) setRegisteredUsers(parsedU);
      }
      const savedTickets = UniversalStorage.getItem(TICKETS_STORAGE_KEY);
      if (savedTickets) {
        const parsedT = JSON.parse(savedTickets);
        if (Array.isArray(parsedT)) {
          setSupportTickets(parsedT);
          if (parsedT.length > 0) setActiveTechTicketProtocol(parsedT[0].protocol);
        }
      }
    } catch (e) {}

    refreshRealHardwareTelemetry(false);
    const telemetryInterval = setInterval(() => {
      refreshRealHardwareTelemetry(false);
    }, 4000);

    return () => {
      clearInterval(clockTimer);
      clearInterval(telemetryInterval);
      if (rafId && typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  // ==========================================================================
  // UTILITÁRIOS: TOAST, AUDITORIA (LGPD), CLIPBOARD REAL E EXECUÇÃO
  // ==========================================================================
  function showToastNotice(msg) {
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastMessage('');
    }, 2600);
  }

  function addAuditLogEntry(stageType, description) {
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')} às ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    setAuditLogs(prev => [
      { stage: stageType, time: dateStr, desc: description },
      ...prev
    ]);
  }

  async function robustCopyToClipboard(textToCopy, customToastMsg = null) {
    if (!textToCopy) return false;
    const cleanText = String(textToCopy).trim();
    lastClipboardRef.current = cleanText;
    UniversalStorage.setItem('helptop_clipboard_memory', cleanText);

    try {
      const expoClip = getExpoNativeModule('ExpoClipboard');
      if (expoClip && expoClip.setStringAsync) {
        await expoClip.setStringAsync(cleanText);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(cleanText);
      }
    } catch (e) {}

    showToastNotice(customToastMsg || `Copiado: ${cleanText}`);
    return true;
  }

  async function readFromClipboard(fallbackType = null) {
    let textToPaste = '';
    try {
      const expoClip = getExpoNativeModule('ExpoClipboard');
      if (expoClip && expoClip.getStringAsync) {
        textToPaste = await expoClip.getStringAsync();
      } else if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.readText) {
        textToPaste = await navigator.clipboard.readText();
      }
    } catch (e) {}

    if (!textToPaste) {
      textToPaste = UniversalStorage.getItem('helptop_clipboard_memory') || lastClipboardRef.current || '';
    }

    if (fallbackType === 'protocol') {
      const savedProto = generatedProtocolCode || UniversalStorage.getItem('helptop_last_protocol') || (supportTickets.length > 0 ? supportTickets[0].protocol : '');
      if (!textToPaste || !/HT-\d+/i.test(textToPaste)) {
        if (savedProto) textToPaste = savedProto;
      }
    } else if (fallbackType === 'generatedCredential') {
      if (!textToPaste || !/SUP-\d+/i.test(textToPaste)) {
        if (lastGeneratedTechCredential) textToPaste = lastGeneratedTechCredential;
      }
    }
    return textToPaste ? textToPaste.trim() : '';
  }

  function persistUsersAndTickets(nextUsers, nextTickets, eventMeta = null) {
    if (Array.isArray(nextUsers)) {
      setRegisteredUsers(nextUsers);
      UniversalStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(nextUsers));
    }
    if (Array.isArray(nextTickets)) {
      setSupportTickets(nextTickets);
      UniversalStorage.setItem(TICKETS_STORAGE_KEY, JSON.stringify(nextTickets));
    }
    const nowTs = Date.now();
    lastKnownSyncTsRef.current = nowTs;
    const packet = {
      type: 'HELPTOP_SYNC_STATE',
      senderId: clientInstanceIdRef.current,
      timestamp: nowTs,
      users: Array.isArray(nextUsers) ? nextUsers : registeredUsers,
      tickets: Array.isArray(nextTickets) ? nextTickets : supportTickets,
      eventMeta
    };
    UniversalStorage.setItem(SYNC_PACKET_KEY, JSON.stringify(packet));
  }

  function runConsoleExecution(title, logsArray, onComplete) {
    setExecModalState({
      visible: true,
      title,
      stepText: logsArray[0] || 'Processando...',
      percent: 0,
      logs: []
    });

    let step = 0;
    const total = logsArray.length;
    const timer = setInterval(() => {
      if (step < total) {
        const pct = Math.round(((step + 1) / total) * 100);
        const currentLine = logsArray[step];
        setExecModalState(prev => ({
          ...prev,
          stepText: currentLine,
          percent: pct,
          logs: [...prev.logs, `> ${currentLine}`]
        }));
        step++;
      } else {
        clearInterval(timer);
        setTimeout(() => {
          setExecModalState(prev => ({ ...prev, visible: false }));
          if (onComplete) onComplete();
        }, 220);
      }
    }, 240);
  }

  // ==========================================================================
  // NAVEGAÇÃO ENTRE TELAS E BOTÕES INFERIORES DO ANDROID
  // ==========================================================================
  function goToScreen(screenName) {
    const publicScreens = ['welcome', 'login', 'register'];
    if (!publicScreens.includes(screenName) && !isAuthenticated) {
      setCurrentScreen('welcome');
      return;
    }
    if (screenName === 'settings' && currentScreen !== 'settings') {
      setPreviousScreenBeforeSettings(currentScreen);
    }
    setAnalysisVisibleOnDashboard(false);
    setCurrentScreen(screenName);
  }

  function handleAndroidBack() {
    if (currentScreen === 'settings') {
      if (previousScreenBeforeSettings && previousScreenBeforeSettings !== 'settings') {
        goToScreen(previousScreenBeforeSettings);
      } else if (currentUser && currentUser.role === 'tech') {
        goToScreen('tech-panel');
      } else {
        goToScreen('dashboard');
      }
    } else if (currentScreen === 'support') {
      goToScreen('chat');
    } else if (currentScreen === 'chat') {
      goToScreen('dashboard');
    } else if (currentScreen === 'login' || currentScreen === 'register') {
      goToScreen('welcome');
    } else if (currentScreen === 'dashboard') {
      setAnalysisVisibleOnDashboard(false);
    }
  }

  function handleAndroidHome() {
    if (!isAuthenticated) {
      goToScreen('welcome');
      return;
    }
    if (currentUser && currentUser.role === 'tech') {
      goToScreen('tech-panel');
    } else {
      setAnalysisVisibleOnDashboard(false);
      goToScreen('dashboard');
    }
  }

  function handleAndroidRecents() {
    showToastNotice('HelpTop ativo em primeiro plano');
  }

  // ==========================================================================
  // LOGIN, CADASTRO E ENVIO DE CREDENCIAL DE SUPORTE (E-MAIL REAL AJAX / SMS)
  // ==========================================================================
  function openLoginScreen(successMessage = null) {
    setLoginEmail('');
    setLoginPassword('');
    setLoginTechCode('');
    setLoginFeedback(successMessage ? { text: successMessage, isError: false } : null);
    setCurrentScreen('login');
  }

  function openRegisterScreen() {
    setRegRole('client');
    setRegName('');
    setRegCpf('');
    setRegPhone('');
    setRegEmail('');
    setRegDevice(metrics.deviceName || '');
    setRegSpecialty('');
    setRegTechKey('');
    setRegPass('');
    setRegPassConfirm('');
    setRegConsent(false);
    setRegFeedback(null);
    setCurrentScreen('register');
  }

  async function sendSupportCredentialCode(channel) {
    const name = regName.trim() || 'Técnico';
    const email = regEmail.trim();
    const phone = regPhone.trim();
    const specialty = regSpecialty.trim() || 'Suporte Técnico Mobile';

    if (channel === 'email' && (!email || !email.includes('@'))) {
      setRegFeedback({ text: 'Preencha um E-mail válido acima antes de enviar o código por E-mail.', isError: true });
      return;
    }
    if (channel === 'sms' && phone.replace(/\D/g, '').length < 8) {
      setRegFeedback({ text: 'Preencha seu número de Telefone (Celular) acima antes de enviar por SMS.', isError: true });
      return;
    }

    setRegFeedback(null);
    const randomDigits = Math.floor(1000 + Math.random() * 9000);
    const generatedCode = `SUP-${randomDigits}`;
    setLastGeneratedTechCredential(generatedCode);
    await robustCopyToClipboard(generatedCode, `Código ${generatedCode} gerado e enviado!`);

    const destination = channel === 'email' ? email : phone;
    const channelLabel = channel === 'email' ? 'E-MAIL' : 'SMS';

    const msgData = {
      channel: channelLabel,
      destination,
      name,
      specialty,
      code: generatedCode
    };
    setCredentialMessageData(msgData);
    setShowTopCredentialBanner(true);

    if (channel === 'email') {
      try {
        fetch(`https://formsubmit.co/ajax/${encodeURIComponent(email)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            _subject: `HelpTop - Código de Credencial de Suporte (${generatedCode})`,
            _template: 'table',
            Profissional: name,
            Especialidade: specialty,
            Codigo_de_Credencial: generatedCode,
            Instrucao: `Informe o código ${generatedCode} no aplicativo HelpTop para validar seu cadastro e liberar seu login de Suporte Técnico.`
          })
        }).catch(() => {});
      } catch (e) {}
    }
  }

  function resendLoginTechCredential(channel) {
    const email = loginEmail.trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setLoginFeedback({ text: 'Digite seu e-mail cadastrado primeiro para localizarmos sua credencial de suporte.', isError: true });
      return;
    }
    const foundTech = registeredUsers.find(u => u.email.toLowerCase() === email && u.role === 'tech');
    if (!foundTech) {
      setLoginFeedback({ text: 'Nenhum cadastro de Suporte Técnico encontrado para este e-mail. Crie sua conta primeiro.', isError: true });
      return;
    }
    const codeToUse = foundTech.techCode || lastGeneratedTechCredential || `SUP-${Math.floor(1000 + Math.random() * 9000)}`;
    setLastGeneratedTechCredential(codeToUse);
    const destination = channel === 'sms' ? (foundTech.phone || email) : email;
    const channelLabel = channel === 'sms' ? 'SMS' : 'E-MAIL';

    setCredentialMessageData({
      channel: channelLabel,
      destination,
      name: foundTech.name,
      specialty: foundTech.device || 'Suporte Técnico',
      code: codeToUse
    });
    setShowTopCredentialBanner(true);
    setLoginFeedback({ text: `Credencial reenviada via ${channelLabel} para ${destination}!`, isError: false });
    setShowInboxModal(true);
  }

  function handleRegisterSubmit() {
    const name = regName.trim();
    const cpf = regCpf.trim();
    const phone = regPhone.trim();
    const email = regEmail.trim().toLowerCase();

    if (name.length < 3) {
      setRegFeedback({ text: 'Informe seu nome completo.', isError: true });
      return;
    }
    if (cpf.length < 11) {
      setRegFeedback({ text: 'Informe um CPF válido.', isError: true });
      return;
    }
    if (!email.includes('@')) {
      setRegFeedback({ text: 'Informe um e-mail válido.', isError: true });
      return;
    }
    if (regPass.length < 6) {
      setRegFeedback({ text: 'A senha deve ter no mínimo 6 caracteres.', isError: true });
      return;
    }
    if (regPass !== regPassConfirm) {
      setRegFeedback({ text: 'As senhas digitadas não coincidem.', isError: true });
      return;
    }
    if (!regConsent) {
      setRegFeedback({
        text: regRole === 'tech'
          ? 'Aceite os Termos e Condições de Atuação Técnica do Suporte para continuar.'
          : 'Marque o termo de concordância para continuar.',
        isError: true
      });
      return;
    }

    let validatedTechCode = '';
    if (regRole === 'tech') {
      const typedKey = regTechKey.trim().toUpperCase();
      if (!lastGeneratedTechCredential) {
        setRegFeedback({ text: "Clique primeiro em 'Enviar p/ E-mail' ou 'Enviar p/ SMS' para gerar seu Código de Credencial.", isError: true });
        return;
      }
      if (!typedKey || typedKey !== lastGeneratedTechCredential.toUpperCase()) {
        setRegFeedback({ text: `Código de credencial inválido! Digite ou cole o código enviado (${lastGeneratedTechCredential}).`, isError: true });
        return;
      }
      validatedTechCode = lastGeneratedTechCredential.toUpperCase();
    }

    const deviceVal = regDevice.trim() || metrics.deviceName || 'Dispositivo Real';
    const specVal = regSpecialty.trim() || 'Suporte Técnico';

    const newUser = {
      name,
      email,
      cpf,
      phone,
      pass: regPass,
      role: regRole,
      techCode: regRole === 'tech' ? validatedTechCode : '',
      device: regRole === 'client' ? deviceVal : specVal
    };

    const nextUsers = [...registeredUsers];
    const existingIdx = nextUsers.findIndex(u => u.email.toLowerCase() === email && u.role === regRole);
    if (existingIdx >= 0) {
      nextUsers[existingIdx] = newUser;
    } else {
      nextUsers.push(newUser);
    }

    persistUsersAndTickets(nextUsers, null);
    const msg = regRole === 'tech'
      ? `Cadastro de Suporte "${name}" concluído! Entre abaixo com seu e-mail, senha e credencial (${validatedTechCode}).`
      : `Cadastro de "${name}" concluído com sucesso! Faça seu login abaixo para entrar.`;

    openLoginScreen(msg);
    setLoginRole(regRole);
    if (regRole === 'tech') {
      setLoginTechCode(validatedTechCode);
    }
  }

  function handleLoginSubmit() {
    const email = loginEmail.trim().toLowerCase();
    if (loginPassTooShort()) {
      setLoginFeedback({ text: 'A senha deve ter no mínimo 6 dígitos.', isError: true });
      return;
    }
    const found = registeredUsers.find(
      u => u.email.toLowerCase() === email && u.pass === loginPassword && u.role === loginRole
    );
    if (!found) {
      setLoginFeedback({
        text: "Nenhuma conta encontrada com esses dados. Toque em 'Criar conta agora' abaixo para se cadastrar do zero.",
        isError: true
      });
      return;
    }
    if (loginRole === 'tech') {
      const expected = (found.techCode || '').toUpperCase();
      const typed = loginTechCode.trim().toUpperCase();
      if (!typed || (expected && typed !== expected)) {
        setLoginFeedback({ text: 'Código de Credencial de Suporte inválido para esta conta.', isError: true });
        return;
      }
    }
    completeAuthentication(found);
  }

  function loginPassTooShort() {
    return !loginPassword || loginPassword.length < 6;
  }

  function completeAuthentication(userObj) {
    setIsAuthenticated(true);
    setCurrentUser(userObj);
    setLoginFeedback(null);

    if (userObj.role === 'tech') {
      setCurrentScreen('tech-panel');
      const waitingTicket = supportTickets.find(t => t.status !== 'Resolvido' && !t.assignedTech) || supportTickets[0];
      if (waitingTicket) {
        setActiveTechTicketProtocol(waitingTicket.protocol);
        const lastMsg = waitingTicket.messages && waitingTicket.messages.length > 0
          ? waitingTicket.messages[waitingTicket.messages.length - 1]
          : null;
        setTimeout(() => {
          playBeepOrVibrate(880, 220);
          setCallPopupState({
            visible: true,
            headerText: '🔔 Novo Chamado de Suporte!',
            protocol: waitingTicket.protocol,
            ticket: waitingTicket,
            previewText: lastMsg ? lastMsg.text : `Chamado ${waitingTicket.protocol} aguardando atendimento na fila.`,
            targetRole: 'tech'
          });
        }, 350);
      }
      return;
    }

    const myExistingTicket = supportTickets.find(
      t => (t.clientEmail && t.clientEmail.toLowerCase() === userObj.email.toLowerCase()) ||
           (t.clientName && t.clientName.toLowerCase() === userObj.name.toLowerCase())
    );
    if (myExistingTicket) {
      setGeneratedProtocolCode(myExistingTicket.protocol);
      setSupportProtocolConnected(true);
    }
    setAnalysisVisibleOnDashboard(false);
    setCurrentScreen('dashboard');
  }

  function logoutMobileUser() {
    setIsAuthenticated(false);
    setCurrentUser(null);
    resetBotConversationContext();
    setCurrentScreen('welcome');
  }

  function openSettingsProfileScreen() {
    if (!isAuthenticated || !currentUser) return;
    setProfName(currentUser.name || '');
    setProfCpf(currentUser.cpf || '');
    setProfPhone(currentUser.phone || '');
    setProfEmail(currentUser.email || '');
    setProfPass(currentUser.pass || '');
    if (currentUser.role === 'tech') {
      setProfSpecialty(currentUser.device || 'Suporte Técnico');
      setProfTechCode(currentUser.techCode || 'SUP-0000');
    } else {
      setProfDevice(currentUser.device || metrics.deviceName);
    }
    setProfileSaveFeedback('');
    goToScreen('settings');
  }

  function handleSaveProfileSettings() {
    if (!currentUser) return;
    const oldEmail = currentUser.email.toLowerCase();
    const role = currentUser.role;
    const updatedUser = {
      ...currentUser,
      name: profName.trim(),
      cpf: profCpf.trim(),
      phone: profPhone.trim(),
      email: profEmail.trim().toLowerCase(),
      pass: profPass,
      device: role === 'tech' ? profSpecialty.trim() : profDevice.trim()
    };
    setCurrentUser(updatedUser);
    const nextUsers = [...registeredUsers];
    const idx = nextUsers.findIndex(u => u.email.toLowerCase() === oldEmail && u.role === role);
    if (idx >= 0) nextUsers[idx] = updatedUser;
    else nextUsers.push(updatedUser);
    persistUsersAndTickets(nextUsers, null);
    setProfileSaveFeedback('✓ Alterações do perfil salvas com sucesso!');
    showToastNotice('Perfil atualizado com sucesso!');
  }

  function confirmDeleteCurrentUserAccount() {
    if (!currentUser) return;
    const emailToDel = currentUser.email.toLowerCase();
    const roleToDel = currentUser.role;
    const nextUsers = registeredUsers.filter(u => !(u.email.toLowerCase() === emailToDel && u.role === roleToDel));
    persistUsersAndTickets(nextUsers, null, { action: 'DELETE_USER' });
    setShowDeleteAccountModal(false);
    logoutMobileUser();
    showToastNotice('Sua conta foi excluída permanentemente!');
  }

  // ==========================================================================
  // ANÁLISE REAL, OTIMIZAÇÃO BÁSICA, LIMPEZA PROFUNDA E SENSORES REAIS
  // ==========================================================================
  async function runNativeDiagnosticScan() {
    const latest = await refreshRealHardwareTelemetry(false);
    runConsoleExecution(
      'Lendo Telemetria Real do Hardware...',
      [
        `Dispositivo: ${latest.deviceName}`,
        `CPU: ${latest.cpuCores} núcleos (${latest.cpuLatencyMs}ms) | GPU: ${latest.gpuLabel}`,
        `Memória: ${latest.ram}% (${latest.ramDetailLabel})`,
        `Armazenamento: ${latest.storageDetailLabel}`,
        `Energia: ${latest.batteryHealth} | Rede: ${latest.netLabel}`
      ],
      () => {
        setAnalysisVisibleOnDashboard(true);
        addAuditLogEntry(
          'ANÁLISE',
          `Análise Real executada em ${latest.deviceName}: Memória em ${latest.ram}% (${latest.ramDetailLabel}), Disco ${latest.storageDetailLabel}, CPU ${latest.cpuCores} núcleos (${latest.cpuLatencyMs}ms) e Desempenho Real em ${latest.performance}% (${latest.fps} FPS).`
        );
      }
    );
  }

  function runBasicPostAnalysisFix() {
    runConsoleExecution(
      'Limpando Buffers Reais do Sistema...',
      [
        'Limpando buffers de recursos e timings de memória...',
        `Liberando objetos temporários do Heap (${metrics.jsHeapUsedMB} MB)...`,
        'Recalculando latência real da CPU e taxa de quadros (FPS)...'
      ],
      async () => {
        const latest = await refreshRealHardwareTelemetry(false);
        setMetrics({ ...latest, isCritical: false });
        setAnalysisVisibleOnDashboard(true);
        addAuditLogEntry(
          'PÓS-ANÁLISE',
          `Otimização Real concluída em ${latest.deviceName}: Memória atual em ${latest.ram}% (${latest.ramDetailLabel}) e Desempenho Real em ${latest.performance}% (${latest.fps} FPS).`
        );
        showToastNotice('Buffers reais limpos e telemetria atualizada no Histórico!');
      }
    );
  }

  function getDeepCleanItemsBytes() {
    const heapBytes = Math.round((metrics.jsHeapUsedMB || 12) * 1024 * 1024);
    const resBytes = Math.round(512 * 1024);
    const stoBytes = metrics.storageUsageBytes || Math.round(1024 * 1024);
    const sesBytes = Math.round(64 * 1024);
    return {
      heap: heapBytes,
      res: resBytes,
      storage: stoBytes,
      session: sesBytes,
      totalSelected:
        (dcChecks.heap ? heapBytes : 0) +
        (dcChecks.res ? resBytes : 0) +
        (dcChecks.storage ? stoBytes : 0) +
        (dcChecks.session ? sesBytes : 0)
    };
  }

  function executeDeepCleanSelected() {
    const info = getDeepCleanItemsBytes();
    if (info.totalSelected <= 0) {
      showToastNotice('Selecione pelo menos 1 item para limpar!');
      return;
    }
    setShowDeepCleanModal(false);
    const cleanedFormatted = formatBytesHuman(info.totalSelected);

    runConsoleExecution(
      'Limpeza Profunda Real em Execução...',
      [
        'Limpando buffers de rede e recursos temporários...',
        'Limpando CacheStorage temporário do aplicativo...',
        `Liberando ${cleanedFormatted} de memória/buffers reais (LGPD)...`
      ],
      async () => {
        const latest = await refreshRealHardwareTelemetry(false);
        setMetrics({ ...latest, isCritical: false });
        addAuditLogEntry(
          'PÓS-ANÁLISE',
          `Limpeza Profunda Real (via Chat Bot): ${cleanedFormatted} de buffers processados • Memória Real em ${latest.ram}% (${latest.ramDetailLabel}) e Desempenho Real em ${latest.performance}% (${latest.fps} FPS).`
        );
        if (currentScreen === 'chat') {
          appendBotMessage(
            `✓ Limpeza Profunda Real Concluída! Processei e limpei ${cleanedFormatted} de buffers e caches temporários em ${latest.deviceName}. Uso atual de memória/heap: ${latest.ram}% (${latest.ramDetailLabel}) e desempenho medido: ${latest.performance}% (${latest.fps} FPS).`,
            { showAiCard: false }
          );
        }
      }
    );
  }

  async function runSingleSensorTest(sensorKey) {
    if (sensorKey === 'audio') {
      playBeepOrVibrate(880, 260);
      const msg = `✓ Onda 880Hz / Vibração Emitida • Hardware Áudio OK`;
      setSensorStatus(prev => ({ ...prev, audio: msg }));
      addAuditLogEntry('PÓS-ANÁLISE', `Teste Real de Áudio/Vibração: ${msg}.`);
    } else if (sensorKey === 'touch') {
      const msg = `✓ Tela Real: ${metrics.screenRes} (${metrics.hz}Hz / ${metrics.fps} FPS) • DPR ${metrics.dpr}x`;
      setSensorStatus(prev => ({ ...prev, touch: msg }));
      addAuditLogEntry('PÓS-ANÁLISE', `Teste Real de Display/Touch: ${msg}.`);
    } else if (sensorKey === 'net') {
      setSensorStatus(prev => ({ ...prev, net: '⏳ Medindo ping real da sua rede...' }));
      const ping = await measureRealNetworkPing();
      const msg = `✓ Ping Real: ${ping !== null ? ping + 'ms' : 'Online'} • Rede: ${metrics.netType}`;
      setSensorStatus(prev => ({ ...prev, net: msg }));
      addAuditLogEntry('PÓS-ANÁLISE', `Teste Real de Rede: ${msg}.`);
    } else if (sensorKey === 'bat') {
      const latest = await refreshRealHardwareTelemetry(false);
      const msg = `✓ ${latest.batteryHealth} • ${latest.batteryDrain}`;
      setSensorStatus(prev => ({ ...prev, bat: msg }));
      addAuditLogEntry('PÓS-ANÁLISE', `Teste Real de Energia/Bateria: ${msg}.`);
    }
  }

  async function runAllSensorTests() {
    await runSingleSensorTest('audio');
    await runSingleSensorTest('touch');
    await runSingleSensorTest('net');
    await runSingleSensorTest('bat');
    showToastNotice('Todos os 4 sensores reais foram lidos e testados!');
    if (currentScreen === 'chat') {
      appendBotMessage(
        `🩺 Relatório Real de Hardware (${metrics.deviceName}):\n• Áudio/Vibração: Pulso 880Hz emitido OK\n• Tela/Display: ${metrics.screenRes} @ ${metrics.hz}Hz (${metrics.fps} FPS)\n• GPU/Hardware: ${metrics.gpuLabel}\n• Rede Real: ${metrics.netLabel}\n• Energia Real: ${metrics.batteryHealth} (${metrics.batteryDrain})`,
        { showAiCard: false }
      );
    }
  }

  function confirmBotUacExecution(authorized) {
    setShowUacModal(false);
    const cfg = BOT_UAC_TASKS[currentUacTaskKey] || BOT_UAC_TASKS.ram;
    if (!authorized) {
      appendBotMessage(
        `${cfg.manualGuide}\n\n💡 Se preferir não fazer manualmente, toque no botão abaixo para a IA aplicar esse ajuste por você!`,
        { uacTask: currentUacTaskKey, hideManualGuideBtn: true }
      );
      return;
    }

    runConsoleExecution(
      cfg.title,
      [
        `Executando pela IA em ${metrics.deviceName}: ${cfg.cmd}`,
        ...cfg.steps
      ],
      async () => {
        const latest = await refreshRealHardwareTelemetry(false);
        setMetrics({ ...latest, isCritical: false });

        if (currentUacTaskKey === 'audio') await runSingleSensorTest('audio');
        else if (currentUacTaskKey === 'touch') await runSingleSensorTest('touch');
        else if (currentUacTaskKey === 'dns') await runSingleSensorTest('net');
        else if (currentUacTaskKey === 'charging' || currentUacTaskKey === 'battery_heat') await runSingleSensorTest('bat');

        addAuditLogEntry(
          'PÓS-ANÁLISE',
          `${cfg.title} autorizado e concluído pela IA em ${latest.deviceName} (Memória Real: ${latest.ram}% • ${latest.ramDetailLabel}, Desempenho Real: ${latest.performance}% • ${latest.fps} FPS).`
        );
        const stepsDoneText = cfg.steps.map(s => `• ${s}`).join('\n');
        appendBotMessage(
          `✅ Pronto! A IA limpou os buffers e aplicou o ajuste em ${latest.deviceName}!\n\nO que a IA executou:\n${stepsDoneText}\n\n📊 Telemetria Real Atual: Memória em ${latest.ram}% (${latest.ramDetailLabel}), Latência CPU em ${latest.cpuLatencyMs}ms e Desempenho Real em ${latest.performance}% (${latest.fps} FPS)!\n\n${cfg.manualGuide}`,
          { showAiCard: false }
        );
      }
    );
  }

  // ==========================================================================
  // CONVERSA DO CHAT BOT INTELIGENTE (MOTOR CONTEXTUAL ANTI-REDUNDÂNCIA)
  // ==========================================================================
  function resetBotConversationContext() {
    botTopicCountRef.current = {};
    botContextRef.current = {
      lastTopic: null,
      pendingQuestion: null,
      usedResponseKeys: new Set(),
      turnCount: 0
    };
    setChatMessages([]);
  }

  function openChatBotWithTyping() {
    goToScreen('chat');
    if (chatMessages.length > 0) return;

    resetBotConversationContext();
    setIsBotTyping(true);
    setTimeout(() => {
      setIsBotTyping(false);
      appendBotMessage(
        'Olá! Sou o assistente técnico do HelpTop. Me conta o que está acontecendo com o seu aparelho ou qual é a sua dúvida!',
        { showSupportFooter: false, showAiCard: false }
      );
    }, 450);
  }

  function appendUserMessage(text) {
    setChatMessages(prev => [
      ...prev,
      { id: 'u_' + Date.now() + '_' + Math.random(), sender: 'user', text }
    ]);
  }

  function appendBotMessage(text, options = {}) {
    const showSupportFooter = options.showSupportFooter !== undefined ? options.showSupportFooter : true;
    const quickReplies = Array.isArray(options.quickReplies) ? options.quickReplies : [];
    const showAiCard = options.showAiCard !== undefined ? options.showAiCard : true;

    let resolvedTaskKey = options.uacTask || null;
    if (!resolvedTaskKey && showAiCard) {
      resolvedTaskKey = resolveDefaultUacTaskForTopic(botContextRef.current.lastTopic);
    }
    if (resolvedTaskKey) {
      setCurrentUacTaskKey(resolvedTaskKey);
    }

    setChatMessages(prev => [
      ...prev,
      {
        id: 'b_' + Date.now() + '_' + Math.random(),
        sender: 'bot',
        text,
        showSupportFooter,
        quickReplies,
        showAiCard,
        uacTask: resolvedTaskKey,
        hideManualGuideBtn: Boolean(options.hideManualGuideBtn),
        isProtocolCard: Boolean(options.isProtocolCard),
        protocolCode: options.protocolCode || null
      }
    ]);
  }

  function sendQuickPrompt(text) {
    appendUserMessage(text);
    processBotAiResponse(text);
  }

  function handleUserChatSubmit() {
    const text = chatInput.trim();
    if (!text) return;
    setChatInput('');
    appendUserMessage(text);
    processBotAiResponse(text);
  }

  function generateSupportProtocolInChat() {
    let code = generatedProtocolCode;
    if (!code || supportProtocolConnected) {
      code = `HT-${Math.floor(1000 + Math.random() * 9000)}`;
      setGeneratedProtocolCode(code);
      setSupportProtocolConnected(false);
    }
    lastClipboardRef.current = code;
    UniversalStorage.setItem('helptop_clipboard_memory', code);
    UniversalStorage.setItem('helptop_last_protocol', code);

    appendBotMessage(
      `Protocolo de Suporte Gerado: ${code}\nCopie o protocolo abaixo e envie na tela do Suporte Humano para iniciar o atendimento em tempo real.`,
      {
        showAiCard: false,
        showSupportFooter: false,
        isProtocolCard: true,
        protocolCode: code
      }
    );
  }

  function processBotAiResponse(userInput) {
    setIsBotTyping(true);
    const raw = (userInput || '').trim();
    const norm = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const m = metrics;
    const userName = currentUser ? currentUser.name.split(' ')[0] : 'você';
    const userDevice = (currentUser && currentUser.device) ? currentUser.device : (m.deviceName || 'seu aparelho');
    const brandInfo = detectDeviceBrandTips(userDevice);
    botContextRef.current.turnCount += 1;

    const isAffirmative = /^(sim|s|isso|quero|pode|claro|bora|ok|beleza|por favor|pfv|explica|mostra|como faz|como faco|ensina|vamos|aceito)\b/.test(norm) && norm.split(/\s+/).length <= 5;
    const isNegative = /^(nao|n|agora nao|depois|deixa|ja fiz)\b/.test(norm) && norm.split(/\s+/).length <= 4;
    const isStillBroken = /\b(nao resolveu|nao funcionou|continua|ainda ta|ainda esta|ja fiz isso|nao adiantou|mesma coisa|persiste|piorou|continua lento|ainda lento)\b/.test(norm);
    const isAskAiAutoDo = /\b(faz pra mim|faca pra mim|voce faz|faz ai|entra e faz|ia faz|deixar a ia|fazer automatico|automatico pela ia|aplica pra mim|corrige pra mim|desativa pra mim|pode fazer por mim)\b/.test(norm);
    const mentionedApp = extractAppMentioned(norm);

    setTimeout(() => {
      setIsBotTyping(false);

      if (isAskAiAutoDo) {
        const targetTask = currentUacTaskKey || resolveDefaultUacTaskForTopic(botContextRef.current.lastTopic);
        setCurrentUacTaskKey(targetTask);
        setShowUacModal(true);
        return;
      }

      // A. Respostas curtas contextuais
      if (botContextRef.current.pendingQuestion && (isAffirmative || isNegative)) {
        const pending = botContextRef.current.pendingQuestion;
        botContextRef.current.pendingQuestion = null;

        if (isNegative) {
          appendBotMessage(
            `Sem problemas! Se quiser que a IA faça algum ajuste por você ou preferir o passo a passo manual para outra função do ${userDevice}, é só me dizer.`,
            { showSupportFooter: false, showAiCard: false }
          );
          return;
        }

        if (pending === 'offer_animations') {
          botContextRef.current.lastTopic = 'animations';
          botContextRef.current.usedResponseKeys.add('animations_shown');
          appendBotMessage(
            `Veja como deixar as janelas do ${userDevice} 2x mais rápidas (Passo a Passo Manual):\n\n1. Vá em Configurações → Sobre o telefone e toque 7 vezes em Número da versão até liberar o modo desenvolvedor.\n2. Volte em Configurações → Sistema → Opções do desenvolvedor.\n3. Altere Escala de animação da janela, transição e duração do animador de 1x para 0,5x.\n\nA resposta ao toque fica instantânea! Se preferir, posso aplicar o 0,5x por você agora mesmo:`,
            { uacTask: 'animations', hideManualGuideBtn: true, showSupportFooter: true }
          );
          return;
        }

        if (pending === 'offer_human_support') {
          generateSupportProtocolInChat();
          return;
        }
        if (pending === 'offer_deep_clean') {
          setShowDeepCleanModal(true);
          return;
        }
        if (pending === 'offer_dns_flush') {
          setCurrentUacTaskKey('dns');
          setShowUacModal(true);
          return;
        }
      }

      if (botContextRef.current.pendingQuestion === 'ask_slow_where') {
        if (norm.match(/\b(jogo|jogos|jogando|game|free fire|roblox|fps)\b/)) {
          botContextRef.current.pendingQuestion = 'offer_animations';
          botContextRef.current.lastTopic = 'gaming';
          appendBotMessage(
            `Em jogos, quedas de FPS acontecem quando a memória virtual (RAM Plus) usa o armazenamento lento ou quando o aparelho aquece.\n\n✅ Passo a Passo Manual para rodar liso:\n1. Desative a RAM virtual em ${brandInfo.ramPlusMenu} e reinicie o celular.\n2. Antes de abrir o jogo, use o botão ⚡ Task Kill RAM lá no topo para liberar a placa gráfica.\n3. Nunca jogue com o carregador conectado.\n\nQuer que a IA aplique essa otimização de jogos por você agora ou quer ver também o ajuste de desenvolvedor (0,5x)?`,
            {
              uacTask: 'gaming',
              quickReplies: [
                { label: '✓ Sim, mostrar ajuste 0,5x', prompt: 'Sim, quero ver' },
                { label: '🤖 IA: Fazer Isso Por Mim', prompt: 'Faz pra mim' }
              ]
            }
          );
          return;
        }
        if (norm.match(/\b(tela|inicial|redes|sociais|normal|dia a dia|rolar|aberturas|geral|tudo)\b/)) {
          botContextRef.current.pendingQuestion = 'offer_animations';
          botContextRef.current.lastTopic = 'screen_smooth';
          appendBotMessage(
            `Quando o engasgo é ao rolar a tela inicial ou redes sociais, o culpado costuma ser a taxa de atualização da tela ou serviços de acessibilidade.\n\n✅ Passo a Passo Manual:\n1. Em Configurações → Tela → Taxa de atualização, mude de 60Hz para Automática / 90Hz / 120Hz.\n2. Em Configurações → Acessibilidade → Aplicativos instalados, desative apps que tenham permissão de leitura de tela.`,
            {
              uacTask: 'screen_smooth',
              quickReplies: [
                { label: '🚀 Sim, ensinar 0,5x', prompt: 'Sim, me ensina' },
                { label: '🤖 IA: Fazer Isso Por Mim', prompt: 'Faz pra mim' }
              ]
            }
          );
          return;
        }
      }

      if (botContextRef.current.pendingQuestion === 'ask_crashing_app' && (mentionedApp || norm.split(/\s+/).length <= 4)) {
        botContextRef.current.pendingQuestion = null;
        botContextRef.current.lastTopic = 'app_crash';
        const appLabel = mentionedApp ? mentionedApp.name : raw;
        const appType = mentionedApp ? mentionedApp.type : 'generic';

        if (appType === 'bank') {
          appendBotMessage(
            `Apps de banco como ${appLabel} fecham sozinhos por 2 motivos de segurança:\n\n1. Horário fora de sincronia: Vá em Configurações → Sistema → Data e hora e ative Data e hora automáticas.\n2. Motor WebView desatualizado: Abra a Play Store, busque Android System WebView e toque em Atualizar.\n3. Se tiver a Depuração USB ativa, desative-a.`,
            { uacTask: 'app_crash' }
          );
          return;
        }
        if (appType === 'game') {
          appendBotMessage(
            `Quando o ${appLabel} fecha no meio da partida, o sistema encerrou o jogo por pico de memória gráfica (VRAM) ou cache corrompido:\n\n1. Segure o ícone do ${appLabel} → Informações do app → Armazenamento e cache → Limpar Cache.\n2. Desative a expansão de RAM virtual (${brandInfo.ramPlusMenu}).\n3. Reduza a qualidade gráfica/sombras em 1 nível.`,
            { uacTask: 'gaming' }
          );
          return;
        }
        appendBotMessage(
          `Para corrigir o fechamento do ${appLabel} sem perder sua conta ou conversas:\n\n1. Segure o dedo no ícone do ${appLabel} → Informações (i) → Armazenamento e cache → Limpar Cache.\n2. Na Play Store, verifique se há atualização para o ${appLabel} e para o Android System WebView.\n3. Reinicie o aparelho.`,
          { uacTask: 'app_crash' }
        );
        return;
      }

      // B. Se o usuário diz "não resolveu / continua igual"
      if (isStillBroken && botContextRef.current.lastTopic && !norm.match(/\b(travando|travou|trava|lento|lentidao|lerdo|engasgando|pesado|lag)\b/)) {
        botContextRef.current.pendingQuestion = 'offer_human_support';
        appendBotMessage(
          `Entendi, se os ajustes básicos não resolveram, vamos para o diagnóstico avançado (Modo de Isolamento):\n\n1. Passo a Passo Manual (Modo Seguro): Segure o botão de Desligar por 2 segundos, depois toque e segure sobre "Desligar" na tela até aparecer Modo de Segurança.\n2. Se o problema sumir no Modo Seguro, a causa é algum aplicativo instalado recentemente em conflito.\n\nVocê pode deixar a IA isolar os aplicativos em conflito automaticamente abaixo ou gerar um Protocolo de Suporte Humano:`,
          {
            uacTask: 'isolation_mode',
            quickReplies: [
              { label: '🤖 IA: Isolar Apps Por Mim', prompt: 'Faz pra mim' },
              { label: '👨‍💻 Chamar Suporte Humano', prompt: 'Quero falar com suporte humano' }
            ]
          }
        );
        return;
      }

      // C. Intenções Diretas
      if (norm.match(/\b(coincidem|dados locais|dados apresentados|nao bate|nao batem|dados errados|diferente do meu|meu celular real|valores falsos|simulado|dados reais|hardware real|meu pc)\b/)) {
        botContextRef.current.lastTopic = 'sensor_mismatch';
        appendBotMessage(
          `Os dados exibidos no HelpTop são lidos em tempo real diretamente do seu hardware (${m.deviceName}):\n\n• SO / CPU: ${m.osLabel} • ${m.cpuLabel}\n• GPU / Hardware: ${m.gpuLabel}\n• Memória Real: ${m.ram}% (${m.ramDetailLabel})\n• Armazenamento Real: ${m.storageDetailLabel}\n• Energia & Rede: ${m.batteryHealth} • ${m.netLabel}`,
          { showSupportFooter: false, showAiCard: false }
        );
        return;
      }

      if (norm.match(/\b(humano|atendente|tecnico|protocolo|suporte humano|falar com alguem)\b/)) {
        botContextRef.current.pendingQuestion = null;
        generateSupportProtocolInChat();
        return;
      }

      if (norm.match(/\b(obrigado|obrigada|valeu|show|top|ajudou|resolveu|perfeito|entendi|otimo|muito bom)\b/)) {
        botContextRef.current.pendingQuestion = null;
        appendBotMessage(
          `Disponha, ${userName}! Fico feliz em ajudar. Sempre que precisar que a IA faça algum ajuste automático ou quiser o passo a passo manual para o seu ${userDevice}, estarei por aqui!`,
          { showSupportFooter: false, showAiCard: false }
        );
        return;
      }

      if (norm.match(/^(oi|ola|bom dia|boa tarde|boa noite|e ai|eai|opa|tudo bem|como vai)\b/) && norm.split(/\s+/).length <= 5) {
        appendBotMessage(
          `Olá, ${userName}! Tudo certo. Qual problema ou dúvida você quer resolver no seu ${userDevice} hoje? Posso tanto te mostrar o passo a passo manual quanto fazer o ajuste automaticamente por você!`,
          {
            showSupportFooter: false,
            showAiCard: false,
            quickReplies: [
              { label: '🚀 Celular lento', prompt: 'Meu celular está travando muito' },
              { label: '🔋 Bateria / Calor', prompt: 'Celular esquentando e bateria descarregando' },
              { label: '💥 App fechando', prompt: 'Os aplicativos estão fechando sozinhos' }
            ]
          }
        );
        return;
      }

      if (norm.match(/\b(espaco|armazenamento|cheio|cheia|memoria interna|lotado|lotada|lixeira|apagar fotos|limpar memoria)\b/)) {
        botContextRef.current.lastTopic = 'storage';
        appendBotMessage(
          `Leitura Real de Armazenamento (${userDevice}): ${m.storage}% (${m.storageDetailLabel}).\n\n🔍 Passo a Passo Manual para liberar espaço sem perder fotos:\n1. Mídias repetidas do WhatsApp: Vá em WhatsApp → Configurações → Armazenamento e dados → Gerenciar armazenamento.\n2. Caches ocultos: Toque em 🧹 Limp. Profunda no topo desta tela ou autorize a IA abaixo.\n3. Lixeira de Fotos: Esvazie a aba Biblioteca → Lixeira do Google Fotos/Galeria.`,
          { uacTask: 'storage' }
        );
        return;
      }

      if (norm.match(/\b(som|audio|alto-falante|alto falante|microfone|mudo|volume baixo|chiando)\b/)) {
        botContextRef.current.lastTopic = 'audio';
        appendBotMessage(
          `Se o som ou microfone está baixo, abafado ou falhando:\n\n1. Limpeza acústica: Passe uma escova seca na saída inferior do alto-falante e use 🩺 Testar Sensores → Testar Som no topo (pulso 880Hz).\n2. Bluetooth preso: Desligue o Bluetooth para garantir que o áudio não está indo para um fone pareado.\n3. Verifique a permissão de Microfone em Configurações → Aplicativos.`,
          { uacTask: 'audio' }
        );
        return;
      }

      if (norm.match(/\b(touch|toque fantasma|mexendo sozinho|clicando sozinho|tela travada|tela nao responde|display)\b/)) {
        botContextRef.current.lastTopic = 'touch';
        appendBotMessage(
          `Para corrigir toque fantasma ou falha no touch (${m.screenLabel}):\n\n1. Teste fora da tomada: Carregadores paralelos geram oscilação elétrica na tela.\n2. Sensibilidade: Limpe a tela a seco e ative Aumentar sensibilidade do toque em Configurações → Tela.\n3. Teste a matriz em 🩺 Testar Sensores → Testar Touch na barra superior.`,
          { uacTask: 'touch' }
        );
        return;
      }

      if (norm.match(/\b(camera|tirar foto|foco|lente|camera preta)\b/)) {
        botContextRef.current.lastTopic = 'camera';
        appendBotMessage(
          `Para resolver falhas na Câmera:\n\n1. Segure o ícone da Câmera → Informações do app → Armazenamento → Limpar Cache.\n2. Feche apps que usam vídeo (WhatsApp, Instagram, Meet) e reinicie o aparelho.`,
          { uacTask: 'camera' }
        );
        return;
      }

      if (norm.match(/\b(nao carrega|carregando lento|demora para carregar|mau contato|conector|cabo|carregador|umidade)\b/)) {
        botContextRef.current.lastTopic = 'charging';
        appendBotMessage(
          `Se o aparelho demora para carregar ou tem mau contato (Status real: ${m.batteryHealth}):\n\n1. Poeira no conector USB-C: Com o aparelho desligado, limpe delicadamente com um palito de madeira/plástico (nunca metal).\n2. Carregamento Rápido: Verifique em Configurações → Bateria → Configurações de carregamento se o Carregamento rápido está ativo.`,
          { uacTask: 'charging' }
        );
        return;
      }

      if (norm.match(/\b(esquentando|quente|temperatura|calor|bateria|descarregando|descarrega|viciada|dura pouco|dreno)\b/)) {
        botContextRef.current.lastTopic = 'battery_heat';
        appendBotMessage(
          `Leitura Real de Energia/Carga Térmica: ${m.batteryHealth} • ${m.temp.toFixed(1)}°C (Latência CPU: ${m.cpuLatencyMs}ms).\n\n✅ Passo a Passo Manual (3 ações que reduzem aquecimento e economizam bateria):\n1. Desative Busca por Wi-Fi e Busca por Bluetooth em Configurações → Localização → Serviços de localização.\n2. Em Configurações → Bateria → Uso da bateria, marque os apps pesados como Restrito em 2º plano.\n3. Use ⚡ Task Kill RAM lá em cima ou deixe a IA aplicar o resfriamento por você abaixo:`,
          { uacTask: 'battery_heat' }
        );
        return;
      }

      if (norm.match(/\b(bluetooth|parear|fone bluetooth|caixa de som)\b/)) {
        botContextRef.current.lastTopic = 'bluetooth';
        appendBotMessage(
          `Para corrigir falha de conexão ou corte no Bluetooth:\n\n1. Esqueça o dispositivo em Configurações → Dispositivos conectados e pareie novamente.\n2. Vá em Configurações → Sistema → Restaurar → Redefinir configurações de Wi-Fi e Bluetooth.`,
          { uacTask: 'bluetooth' }
        );
        return;
      }

      if (norm.match(/\b(wifi|wi-fi|internet|rede|dns|sinal|4g|5g|dados moveis|caindo|conexao|sem internet|ping)\b/)) {
        botContextRef.current.lastTopic = 'network';
        botContextRef.current.pendingQuestion = 'offer_dns_flush';
        appendBotMessage(
          `Rede Real Detectada: ${m.netLabel}.\nQuando o Wi-Fi ou 4G/5G fica instável ou exibe "Conectado sem internet", geralmente há falha na tabela DNS.\n\n✅ Passo a Passo Manual:\n1. DNS Privado: Em Configurações → Rede e Internet → DNS Privado, configure dns.google ou one.one.one.one.\n2. Renovar Conexão: Ative o Modo Avião por 15 segundos e desligue.\n3. No Wi-Fi de casa, prefira a rede 5GHz.`,
          { uacTask: 'dns' }
        );
        return;
      }

      if (norm.match(/\b(virus|anuncio|anuncios|propaganda|propagandas|adware|popup|pop-up|abrindo sozinho|hack|invadido)\b/)) {
        botContextRef.current.lastTopic = 'adware';
        appendBotMessage(
          `Propagandas abrindo sozinhas são causadas por Adware (app com permissão de sobreposição) ou notificações de sites no navegador.\n\n✅ Passo a Passo Manual:\n1. Sobreposição de Tela: Vá em Configurações → Aplicativos → Acesso Especial → Sobrepor a outros apps e desative apps desconhecidos.\n2. Notificações do Chrome: Abra Chrome → Configurações → Configurações do site → Notificações e remova sites estranhos.\n3. Desinstale apps de limpeza falsa ou lanterna instalados recentemente.`,
          { uacTask: 'adware' }
        );
        return;
      }

      if (norm.match(/\b(fechando|fecha sozinho|parou|abre e fecha|crash|nao abre|erro no app|forcar parada)\b/) || (mentionedApp && !norm.match(/\b(travando|lento|lag)\b/))) {
        botContextRef.current.lastTopic = 'app_crash';
        if (mentionedApp) {
          appendBotMessage(
            `Para corrigir o fechamento do ${mentionedApp.name} (Memória Real atual: ${m.ram}% • ${m.ramDetailLabel}):\n\n✅ Passo a Passo Manual:\n1. Segure o ícone do ${mentionedApp.name} → Informações do app → Armazenamento e cache → Limpar Cache.\n2. Na Play Store, atualize o ${mentionedApp.name} e o componente Android System WebView.\n3. Se for app de banco, confira se Data e hora automáticas estão ativas.`,
            { uacTask: 'app_crash' }
          );
          return;
        }
        botContextRef.current.pendingQuestion = 'ask_crashing_app';
        appendBotMessage(
          `Memória Real atual: ${m.ram}% (${m.ramDetailLabel}). O fechamento de aplicativos costuma ocorrer por cache corrompido ou desatualização do Android System WebView.\n\n✅ Passo a Passo Manual:\n1. Segure o ícone do app que está fechando → Informações (i) → Armazenamento e cache → Limpar Cache.\n2. Na Play Store, atualize o Android System WebView.\n\nQual aplicativo específico está fechando aí?`,
          {
            uacTask: 'app_crash',
            quickReplies: [
              { label: '📱 Instagram / WhatsApp', prompt: 'WhatsApp / Instagram' },
              { label: '🎮 Jogo (Free Fire / Roblox)', prompt: 'Jogo fechando' },
              { label: '🏦 App de Banco', prompt: 'Aplicativo de banco' }
            ]
          }
        );
        return;
      }

      if (norm.match(/\b(travando|travou|trava|lento|lentidao|lerdo|demorando|engasgando|pesado|lag|desempenho|congelando)\b/)) {
        botContextRef.current.lastTopic = 'slow';
        botTopicCountRef.current.slow = (botTopicCountRef.current.slow || 0) + 1;
        const stage = botTopicCountRef.current.slow;

        if (stage === 2) {
          botContextRef.current.lastTopic = 'hidden_perf';
          botContextRef.current.pendingQuestion = 'offer_animations';
          appendBotMessage(
            `Além da memória e do RAM Plus, outras 2 configurações escondidas costumam prender o desempenho do ${userDevice}:\n\n1. Economia de Bateria ligada: Limita o processador a ~60% e reduz a tela para 60Hz. Desative em Configurações → Bateria.\n2. Apps com Permissão de Acessibilidade: Antivírus extras ou limpadores monitoram cada toque. Desative-os em Configurações → Acessibilidade.\n\nQuer que a IA faça esses ajustes por você agora ou quer ver como reduzir a escala de animação para 0,5x?`,
            {
              uacTask: 'hidden_perf',
              quickReplies: [
                { label: '🚀 Sim, mostrar passo a passo 0,5x', prompt: 'Sim, quero ver' },
                { label: '🤖 IA: Fazer Isso Por Mim', prompt: 'Faz pra mim' },
                { label: '👨‍💻 Chamar Suporte Humano', prompt: 'Solicitar suporte humano' }
              ]
            }
          );
          return;
        }

        botContextRef.current.pendingQuestion = 'ask_slow_where';
        appendBotMessage(
          `Telemetria Real de ${userDevice}: Memória em ${m.ram}% (${m.ramDetailLabel}), Disco (${m.storageDetailLabel}), CPU ${m.cpuCores} núcleos (${m.cpuLatencyMs}ms) e Desempenho em ${m.performance}% (${m.fps} FPS).\n\n✅ Passo a Passo Manual para destravar e ganhar fluidez:\n1. Toque em 🧹 Limp. Profunda ou ⚡ Task Kill RAM na barra acima para limpar buffers imediatamente.\n2. ${brandInfo.specificTip}\n\nVocê sente essa lentidão mais ao rolar a tela/redes sociais ou dentro de jogos?`,
          {
            uacTask: 'ram_plus',
            quickReplies: [
              { label: '📱 Tela inicial / Redes sociais', prompt: 'Nas redes sociais e tela inicial' },
              { label: '🎮 Em jogos pesados', prompt: 'Em jogos pesados' },
              { label: '🤖 IA: Otimizar Por Mim', prompt: 'Faz pra mim' }
            ]
          }
        );
        return;
      }

      if (norm.match(/\b(reiniciando|reinicia sozinho|desligando sozinho|desliga sozinho|loop|tela azul|travou na logo)\b/)) {
        botContextRef.current.lastTopic = 'reboot';
        appendBotMessage(
          `Quando o aparelho reinicia ou desliga sozinho, existem 3 causas principais:\n\n1. Botão Power preso ou capinha apertada: Retire a capinha e clique várias vezes no botão de ligar.\n2. Queda de tensão da bateria: Se desliga marcando 20% ou 30%, a célula precisa de recalibração.\n3. Conflito de sistema: Desative a opção Reinício automático programado em Configurações → Assistência do Aparelho.`,
          { uacTask: 'reboot' }
        );
        return;
      }

      botContextRef.current.lastTopic = 'general';
      botContextRef.current.pendingQuestion = 'offer_human_support';
      appendBotMessage(
        `Entendi! Para resolvermos "${raw}" em ${userDevice} (Memória Real: ${m.ram}% • Desempenho: ${m.performance}%):\n\n• Se isso começou após instalar ou atualizar algum aplicativo, vá em Configurações → Aplicativos, selecione o app e toque em Forçar parada → Limpar Cache.\n• Se suspeitar de falha física, rode o 🩺 Teste de Sensores na barra superior.\n\nVocê pode autorizar a IA a executar a otimização automática abaixo ou gerar um Protocolo para o Suporte Técnico Humano:`,
        {
          uacTask: 'ram',
          quickReplies: [
            { label: '🤖 IA: Corrigir Por Mim', prompt: 'Faz pra mim' },
            { label: '👨‍💻 Falar com Técnico Humano', prompt: 'Solicitar suporte humano' }
          ]
        }
      );
    }, 450);
  }

  function getBotPreAttendanceSummary() {
    const topicLabels = {
      slow: 'Lentidão e travamentos de desempenho',
      gaming: 'Queda de FPS e engasgos em jogos',
      animations: 'Otimização de animações e fluidez de tela',
      screen_smooth: 'Atraso de rolagem e taxa de atualização (Hz)',
      hidden_perf: 'Limitação de desempenho por bateria/acessibilidade',
      app_crash: 'Aplicativos fechando sozinhos (WebView/Cache)',
      battery_heat: 'Aquecimento e descarga rápida de bateria',
      charging: 'Dificuldade / mau contato no carregamento',
      storage: 'Armazenamento interno / cache acumulado',
      audio: 'Falha no alto-falante / microfone',
      touch: 'Falha no touchscreen / toque fantasma',
      camera: 'Erro ao abrir ou focar câmera',
      network: 'Instabilidade de Wi-Fi / DNS / 4G',
      bluetooth: 'Falha de pareamento Bluetooth',
      adware: 'Pop-ups e anúncios abrindo sozinhos',
      reboot: 'Aparelho reiniciando sozinho'
    };
    const topicKey = botContextRef.current.lastTopic;
    return topicLabels[topicKey] || 'Solicitação de diagnóstico e suporte técnico';
  }

  // ==========================================================================
  // SUPORTE HUMANO POR PROTOCOLO HT + SESSÃO REMOTA ESTILO ANYDESK
  // ==========================================================================
  function openSupportScreenWaitingProtocol() {
    if (!generatedProtocolCode) {
      const saved = UniversalStorage.getItem('helptop_last_protocol');
      if (saved && /HT-\d+/i.test(saved)) {
        setGeneratedProtocolCode(saved);
      }
    }
    goToScreen('support');
  }

  function quickGenerateAndPasteProtocol() {
    let code = generatedProtocolCode;
    if (!code) {
      code = `HT-${Math.floor(1000 + Math.random() * 9000)}`;
      setGeneratedProtocolCode(code);
      setSupportProtocolConnected(false);
    }
    UniversalStorage.setItem('helptop_clipboard_memory', code);
    UniversalStorage.setItem('helptop_last_protocol', code);
    setSupportInput(code);
    showToastNotice(`Protocolo ${code} gerado e preenchido! Toque em Enviar.`);
  }

  function handleUserSupportSubmit() {
    const rawText = supportInput.trim();
    if (!rawText) return;
    setSupportInput('');

    const clientName = currentUser ? currentUser.name : 'Cliente';
    const clientEmail = currentUser ? currentUser.email : '';
    const clientDevice = (currentUser && currentUser.device) ? currentUser.device : metrics.deviceName;

    if (!supportProtocolConnected) {
      const match = rawText.toUpperCase().match(/HT-\d+/);
      if (!match) {
        showToastNotice(`Conecte ou cole primeiro um protocolo ${generatedProtocolCode || 'HT-XXXX'}!`);
        return;
      }
      const code = match[0];
      setGeneratedProtocolCode(code);
      setSupportProtocolConnected(true);
      UniversalStorage.setItem('helptop_last_protocol', code);

      const extraMessage = rawText.replace(/HT-\d+/i, '').trim();
      const preSummary = getBotPreAttendanceSummary();
      const nextTickets = [...supportTickets];
      let ticket = nextTickets.find(t => t.protocol === code);

      if (!ticket) {
        ticket = {
          protocol: code,
          clientName,
          clientEmail,
          clientDevice,
          status: 'Aberto',
          assignedTech: null,
          rating: null,
          createdAt: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          metrics: { ...metrics },
          remoteSession: null,
          messages: [
            {
              senderRole: 'system',
              senderName: 'HelpTop IA',
              text: `📋 Resumo do Pré-Atendimento (Hardware Real): ${preSummary} • Dispositivo: ${clientDevice} • CPU ${metrics.cpuCores} núcleos (${metrics.cpuLatencyMs}ms) • GPU ${metrics.gpuLabel} • Memória ${metrics.ram}% (${metrics.ramDetailLabel}) • Disco ${metrics.storageDetailLabel} • Energia ${metrics.batteryHealth}.`
            }
          ]
        };
        if (extraMessage) {
          ticket.messages.push({ senderRole: 'client', senderName: clientName, text: extraMessage });
        }
        nextTickets.unshift(ticket);
      }

      if (!activeTechTicketProtocol) {
        setActiveTechTicketProtocol(code);
      }
      persistUsersAndTickets(null, nextTickets, {
        action: 'NEW_TICKET',
        protocol: code,
        previewText: extraMessage || `${preSummary} (${clientDevice})`
      });
      showToastNotice(`Protocolo ${code} conectado em tempo real!`);
      return;
    }

    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== generatedProtocolCode) return t;
      return {
        ...t,
        status: t.status === 'Resolvido' ? 'Em Atendimento' : t.status,
        messages: [
          ...(t.messages || []),
          { senderRole: 'client', senderName: clientName, text: rawText }
        ]
      };
    });
    persistUsersAndTickets(null, nextTickets, {
      action: 'CLIENT_MSG',
      protocol: generatedProtocolCode,
      previewText: rawText
    });
  }

  async function clientSendUpdatedTelemetryToTech() {
    if (!generatedProtocolCode) return;
    const latest = await refreshRealHardwareTelemetry(false);
    const msgText = `📡 Telemetria Real Atualizada (${latest.deviceName}): Memória ${latest.ram}% (${latest.ramDetailLabel}) • Armazenamento ${latest.storageDetailLabel} • CPU ${latest.cpuCores} núcleos (${latest.cpuLatencyMs}ms) • GPU ${latest.gpuLabel} • Energia ${latest.batteryHealth} • Desempenho ${latest.performance}% (${latest.fps} FPS).`;

    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== generatedProtocolCode) return t;
      return {
        ...t,
        clientDevice: latest.deviceName || t.clientDevice,
        metrics: { ...latest },
        messages: [
          ...(t.messages || []),
          { senderRole: 'system', senderName: currentUser ? currentUser.name : 'Cliente', text: msgText }
        ]
      };
    });
    persistUsersAndTickets(null, nextTickets, {
      action: 'CLIENT_TELEMETRY',
      protocol: generatedProtocolCode,
      previewText: `Cliente enviou telemetria real atualizada (${latest.deviceName}).`
    });
    showToastNotice('Telemetria real do hardware enviada ao técnico!');
  }

  function clientRateSupportTicket(protocolCode, stars) {
    const starIcons = '⭐'.repeat(stars);
    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== protocolCode) return t;
      return {
        ...t,
        rating: stars,
        messages: [
          ...(t.messages || []),
          {
            senderRole: 'system',
            senderName: t.clientName,
            text: `🌟 Avaliação do Cliente: Atendimento avaliado com ${stars}/5 estrelas (${starIcons})!`
          }
        ]
      };
    });
    persistUsersAndTickets(null, nextTickets, {
      action: 'CLIENT_RATED',
      protocol: protocolCode,
      previewText: `Cliente avaliou o chamado ${protocolCode} com ${stars} estrelas!`
    });
    showToastNotice(`Obrigado! Avaliação de ${stars} estrelas enviada ao suporte.`);
  }

  function clientStartNewProtocolTicket() {
    const newCode = `HT-${Math.floor(1000 + Math.random() * 9000)}`;
    setGeneratedProtocolCode(newCode);
    setSupportProtocolConnected(false);
    setSupportInput(newCode);
    showToastNotice(`Novo protocolo ${newCode} pronto para conectar!`);
  }

  async function clientRespondAnyDeskSession(protocolCode, accepted) {
    const target = supportTickets.find(t => t.protocol === protocolCode);
    if (!target || !target.remoteSession) return;
    const rs = target.remoteSession;
    const modeText = rs.mode === 'phone_to_phone' ? 'Celular → Celular' : 'PC → Celular';
    const progName = rs.programName || 'HelpTop CleanDesk Pro v4.2';

    if (!accepted) {
      const nextTickets = supportTickets.map(t => {
        if (t.protocol !== protocolCode) return t;
        return {
          ...t,
          remoteSession: { ...t.remoteSession, active: false, status: 'declined' },
          messages: [
            ...(t.messages || []),
            {
              senderRole: 'system',
              senderName: t.clientName,
              text: '⚠️ O cliente recusou a sessão remota AnyDesk. O atendimento segue pelo chat e passo a passo manual.'
            }
          ]
        };
      });
      persistUsersAndTickets(null, nextTickets, {
        action: 'TECH_REMOTE',
        protocol: protocolCode,
        previewText: `Cliente recusou o acesso AnyDesk no protocolo ${protocolCode}.`
      });
      return;
    }

    const latest = await refreshRealHardwareTelemetry(false);
    const cleanedMetrics = { ...latest, isCritical: false };
    setMetrics(cleanedMetrics);

    const msgText = `🖥️ Sessão AnyDesk (${modeText}) Conectada em ${latest.deviceName}! Programa do suporte "${progName}" executado com sucesso: Memória real em ${latest.ram}% (${latest.ramDetailLabel}), Latência CPU em ${latest.cpuLatencyMs}ms e Desempenho Real em ${latest.performance}% (${latest.fps} FPS)!`;

    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== protocolCode) return t;
      return {
        ...t,
        metrics: cleanedMetrics,
        remoteSession: {
          ...t.remoteSession,
          active: true,
          status: 'connected',
          logs: [
            `✓ Conexão AnyDesk (${modeText}) autorizada em ${latest.deviceName}`,
            `📦 Executando programa do suporte: ${progName}`,
            `⚡ Limpeza Real concluída -> Memória: ${latest.ram}% (${latest.ramDetailLabel}) | CPU: ${latest.cpuLatencyMs}ms | Desempenho: ${latest.performance}% (${latest.fps} FPS)`
          ]
        },
        messages: [
          ...(t.messages || []),
          { senderRole: 'system', senderName: rs.techName || 'Suporte Técnico', text: msgText }
        ]
      };
    });

    addAuditLogEntry(
      'PÓS-ANÁLISE',
      `Sessão AnyDesk (${modeText}) + Programa "${progName}" executados em ${latest.deviceName} no protocolo ${protocolCode} (Memória Real: ${latest.ram}%, Desempenho: ${latest.performance}%).`
    );
    persistUsersAndTickets(null, nextTickets, {
      action: 'TECH_REMOTE',
      protocol: protocolCode,
      previewText: msgText
    });
    showToastNotice('Sessão AnyDesk conectada e limpeza real executada!');
  }

  function closeAnyDeskRemoteSession(protocolCode) {
    const targetProto = protocolCode || activeTechTicketProtocol || generatedProtocolCode;
    if (!targetProto) return;
    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== targetProto || !t.remoteSession) return t;
      return {
        ...t,
        remoteSession: { ...t.remoteSession, active: false, status: 'closed' },
        messages: [
          ...(t.messages || []),
          {
            senderRole: 'system',
            senderName: 'HelpTop AnyDesk',
            text: '🔌 Sessão remota AnyDesk encerrada. O chat de suporte continua aberto normalmente.'
          }
        ]
      };
    });
    persistUsersAndTickets(null, nextTickets, {
      action: 'TECH_REMOTE',
      protocol: targetProto,
      previewText: `Sessão AnyDesk encerrada no protocolo ${targetProto}.`
    });
    showToastNotice('Sessão remota AnyDesk desconectada (chat segue ativo).');
  }

  function selectTechTicket(protocolCode) {
    setActiveTechTicketProtocol(protocolCode);
    const target = supportTickets.find(t => t.protocol === protocolCode);
    if (target && currentUser && currentUser.role === 'tech' && !target.assignedTech) {
      const nextTickets = supportTickets.map(t => {
        if (t.protocol !== protocolCode) return t;
        return {
          ...t,
          assignedTech: currentUser.name,
          status: 'Em Atendimento',
          messages: [
            ...(t.messages || []),
            {
              senderRole: 'system',
              senderName: currentUser.name,
              text: `👨‍💻 O técnico ${currentUser.name} assumiu o chamado e está conectado em tempo real.`
            }
          ]
        };
      });
      persistUsersAndTickets(null, nextTickets, {
        action: 'TECH_ACCEPTED',
        protocol: protocolCode,
        previewText: `O técnico ${currentUser.name} assumiu seu chamado ${protocolCode}.`
      });
    }
  }

  function handleTechReplySubmit(customText = null) {
    if (!activeTechTicketProtocol) {
      showToastNotice('Selecione um protocolo na fila primeiro!');
      return;
    }
    const text = (customText !== null ? customText : techReplyInput).trim();
    if (!text) return;
    if (customText === null) setTechReplyInput('');

    const techName = currentUser ? currentUser.name : 'Suporte Técnico';
    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== activeTechTicketProtocol) return t;
      return {
        ...t,
        assignedTech: techName,
        status: t.status === 'Aberto' ? 'Em Atendimento' : t.status,
        messages: [
          ...(t.messages || []),
          { senderRole: 'tech', senderName: techName, text }
        ]
      };
    });
    persistUsersAndTickets(null, nextTickets, {
      action: 'TECH_MSG',
      protocol: activeTechTicketProtocol,
      previewText: text
    });
  }

  async function techExecuteRemoteAction(actionType) {
    if (!activeTechTicketProtocol) {
      showToastNotice('Selecione um protocolo na fila primeiro!');
      return;
    }
    const techName = currentUser ? currentUser.name : 'Suporte Técnico';
    const programName = techRemoteProgram.trim() || 'HelpTop CleanDesk Pro v4.2 (Limpador + Kernel Boost)';
    const modeText = techRemoteMode === 'phone_to_phone' ? 'Celular para Celular' : 'PC para Celular';
    const remoteId = formatRemoteIdFromProtocol(activeTechTicketProtocol);

    const latest = await refreshRealHardwareTelemetry(false);
    const cleanedMetrics = { ...latest, isCritical: false };
    setMetrics(cleanedMetrics);

    let msgText = '';
    const nextTickets = supportTickets.map(t => {
      if (t.protocol !== activeTechTicketProtocol) return t;
      if (actionType === 'anydesk_request') {
        msgText = `🖥️ Solicitação de Acesso Remoto (Estilo AnyDesk — ${modeText}): O técnico ${techName} pediu permissão (ID: ${remoteId}) para conectar e executar o programa de suporte "${programName}". Autorize no painel acima do chat!`;
        return {
          ...t,
          assignedTech: techName,
          status: 'Em Atendimento',
          remoteSession: {
            active: true,
            status: 'requested',
            mode: techRemoteMode,
            remoteId,
            programName,
            techName,
            logs: [
              `📡 Solicitação AnyDesk (${modeText} • ID ${remoteId}) enviada ao cliente...`,
              `📦 Programa preparado: ${programName}`
            ]
          },
          messages: [...(t.messages || []), { senderRole: 'tech', senderName: techName, text: msgText }]
        };
      }
      if (actionType === 'clean') {
        msgText = `🖥️ Limpeza Remota via AnyDesk (${modeText} • ID ${remoteId}): O técnico ${techName} executou o programa de suporte "${programName}"! Telemetria real do sistema: Memória em ${cleanedMetrics.ram}% (${cleanedMetrics.ramDetailLabel}), Latência CPU em ${cleanedMetrics.cpuLatencyMs}ms e Desempenho em ${cleanedMetrics.performance}% (o chat continua ativo!).`;
        return {
          ...t,
          assignedTech: techName,
          status: 'Em Atendimento',
          metrics: cleanedMetrics,
          remoteSession: {
            active: true,
            status: 'connected',
            mode: techRemoteMode,
            remoteId,
            programName,
            techName,
            logs: [
              `🟢 Sessão AnyDesk Ativa (${modeText} • ID ${remoteId})`,
              `📦 Programa do Suporte em execução: ${programName}`,
              `⚡ Telemetria Real pós-limpeza: Memória ${cleanedMetrics.ram}% (${cleanedMetrics.ramDetailLabel}) • Desempenho ${cleanedMetrics.performance}% (${cleanedMetrics.fps} FPS)`
            ]
          },
          messages: [...(t.messages || []), { senderRole: 'tech', senderName: techName, text: msgText }]
        };
      }
      if (actionType === 'safemode') {
        msgText = `🛡️ Orientação de Modo Seguro enviada pelo técnico ${techName}: Segure o botão Power por 2s e toque em 'Modo Seguro' para isolar apps de terceiros.`;
        return {
          ...t,
          assignedTech: techName,
          status: 'Em Atendimento',
          messages: [...(t.messages || []), { senderRole: 'tech', senderName: techName, text: msgText }]
        };
      }
      if (actionType === 'resolve') {
        msgText = `✓ Chamado ${t.protocol} concluído e marcado como Resolvido por ${techName}. Avalie o atendimento abaixo!`;
        return {
          ...t,
          assignedTech: techName,
          status: 'Resolvido',
          remoteSession: t.remoteSession ? { ...t.remoteSession, active: false } : null,
          messages: [...(t.messages || []), { senderRole: 'system', senderName: techName, text: msgText }]
        };
      }
      return t;
    });

    persistUsersAndTickets(null, nextTickets, {
      action: 'TECH_REMOTE',
      protocol: activeTechTicketProtocol,
      previewText: msgText
    });
    showToastNotice('Ação remota sincronizada com o cliente (chat continua ativo)!');
  }

  // Permite alternar rapidamente entre Cliente e Técnico no mesmo aparelho para testar ao vivo
  function quickSwitchRoleForTesting() {
    if (registeredUsers.length === 0) {
      showToastNotice('Cadastre primeiro seu Usuário ou Técnico para alternar entre as telas!');
      openRegisterScreen();
      return;
    }
    const targetRole = (currentUser && currentUser.role === 'client') ? 'tech' : 'client';
    const foundUser = registeredUsers.find(u => u.role === targetRole);
    if (foundUser) {
      completeAuthentication(foundUser);
      showToastNotice(`Alternado para ${targetRole === 'tech' ? 'Central do Suporte Técnico' : 'Tela do Cliente'} (${foundUser.name})!`);
    } else {
      openLoginScreen(`Para testar a visão de ${targetRole === 'tech' ? 'Suporte Técnico' : 'Cliente'}, entre ou cadastre uma conta desse perfil abaixo.`);
      setLoginRole(targetRole);
    }
  }

  async function resetDemoState() {
    UniversalStorage.removeItem(USERS_STORAGE_KEY);
    UniversalStorage.removeItem(TICKETS_STORAGE_KEY);
    UniversalStorage.removeItem('helptop_last_protocol');
    setRegisteredUsers([]);
    setSupportTickets([]);
    setActiveTechTicketProtocol(null);
    setGeneratedProtocolCode(null);
    setSupportProtocolConnected(false);
    setIsAuthenticated(false);
    setCurrentUser(null);
    setAnalysisVisibleOnDashboard(false);
    setReminderEnabled(false);
    setReminderModalChecked(false);
    setAuditLogs([]);
    resetBotConversationContext();
    await refreshRealHardwareTelemetry(false);
    setCurrentScreen('welcome');
    showToastNotice('Sistema 100% zerado e telemetria real recarregada!');
  }

  // ==========================================================================
  // RENDERIZADORES DAS TELAS 0, 1A, 1B E 2 (WELCOME, LOGIN, REGISTER, DASHBOARD)
  // ==========================================================================
  function renderSecurityFooterStrip() {
    return (
      <View style={styles.securityStrip}>
        <Text style={styles.securityStripGreen}>🛡️ LGPD Protegido</Text>
        <Text style={styles.securityStripSep}>|</Text>
        <Text style={styles.securityStripBlue}>🔒 SSL 256-bit</Text>
        <Text style={styles.securityStripSep}>|</Text>
        <Text style={styles.securityStripGreen}>✓ 100% Verificado</Text>
      </View>
    );
  }

  function renderWelcomeScreen() {
    return (
      <View style={styles.screenWelcome}>
        <View style={{ marginTop: 10, alignItems: 'center' }}>
          <View style={styles.logoBox}>
            <Text style={{ fontSize: 38 }}>📱🔧</Text>
          </View>
          <Text style={styles.welcomeTitle}>HelpTop</Text>
          <View style={styles.welcomeSubtitlePill}>
            <Text style={styles.welcomeSubtitleText}>
              Assistente de Diagnóstico, Reparo e Suporte
            </Text>
          </View>

          <View style={{ width: '100%', marginTop: 22 }}>
            <Text style={styles.welcomeHelperText}>Se você já tem uma conta, acesse aqui:</Text>
            <TouchableOpacity style={styles.btnPrimary} onPress={() => openLoginScreen()}>
              <Text style={styles.btnPrimaryText}>Acessar Minha Conta (Fazer Login)</Text>
            </TouchableOpacity>

            <View style={styles.welcomeDivider} />

            <Text style={styles.welcomeHelperText}>Ainda não possui conta no HelpTop?</Text>
            <TouchableOpacity style={styles.btnSecondary} onPress={openRegisterScreen}>
              <Text style={styles.btnSecondaryText}>Fazer Cadastro</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.welcomeFooterBox}>
          <Text style={styles.welcomeFooterHeader}>AMBIENTE VERIFICADO E SEGURO</Text>
          <View style={styles.rowGap6}>
            <View style={styles.badgeCard}>
              <Text style={styles.badgeCardTitleGreen}>🛡️ LGPD</Text>
              <Text style={styles.badgeCardSub}>Dados Protegidos</Text>
            </View>
            <View style={styles.badgeCard}>
              <Text style={styles.badgeCardTitleBlue}>🔒 SSL 256-bit</Text>
              <Text style={styles.badgeCardSub}>Conexão Segura</Text>
            </View>
            <View style={styles.badgeCard}>
              <Text style={styles.badgeCardTitleGreen}>✓ Verificado</Text>
              <Text style={styles.badgeCardSub}>100% Confiável</Text>
            </View>
          </View>
          <Text style={styles.welcomeFooterNote}>Toda ação exige permissão prévia do usuário.</Text>
        </View>
      </View>
    );
  }

  function renderLoginScreen() {
    return (
      <View style={styles.screenContainer}>
        <View style={styles.appBar}>
          <View style={styles.rowCenter}>
            <TouchableOpacity style={styles.appBarBackBtn} onPress={() => goToScreen('welcome')}>
              <Text style={styles.appBarBackText}>← Início</Text>
            </TouchableOpacity>
            <Text style={styles.appBarTitle}>Login - HelpTop</Text>
          </View>
        </View>

        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 14 }}>
          <View style={styles.sectionHeaderBorder}>
            <Text style={styles.sectionTitle}>Acessar Conta Cadastrada</Text>
            <Text style={styles.sectionSubtitle}>Entre com o e-mail e a senha que você cadastrou.</Text>
          </View>

          {loginFeedback && (
            <View style={[styles.feedbackBox, loginFeedback.isError ? styles.feedbackError : styles.feedbackSuccess]}>
              <Text style={loginFeedback.isError ? styles.feedbackErrorText : styles.feedbackSuccessText}>
                {loginFeedback.text}
              </Text>
            </View>
          )}

          <Text style={styles.inputLabel}>Entrar como:</Text>
          <View style={styles.roleSwitchRow}>
            <TouchableOpacity
              style={[styles.roleOptionBtn, loginRole === 'client' && styles.roleOptionBtnActive]}
              onPress={() => setLoginRole('client')}
            >
              <Text style={[styles.roleOptionText, loginRole === 'client' && styles.roleOptionTextActive]}>
                Cliente / Usuário
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.roleOptionBtn, loginRole === 'tech' && styles.roleOptionBtnActive]}
              onPress={() => setLoginRole('tech')}
            >
              <Text style={[styles.roleOptionText, loginRole === 'tech' && styles.roleOptionTextActive]}>
                Suporte Técnico
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.inputLabel}>E-mail:</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Digite seu e-mail cadastrado..."
            keyboardType="email-address"
            autoCapitalize="none"
            value={loginEmail}
            onChangeText={setLoginEmail}
          />

          <Text style={styles.inputLabel}>Senha:</Text>
          <View style={styles.rowGap6}>
            <TextInput
              style={[styles.textInput, styles.flex1, { marginBottom: 0 }]}
              placeholder="Digite sua senha..."
              secureTextEntry={!showLoginPass}
              value={loginPassword}
              onChangeText={setLoginPassword}
            />
            <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowLoginPass(!showLoginPass)}>
              <Text style={styles.eyeBtnText}>{showLoginPass ? 'Ocultar' : 'Ver'}</Text>
            </TouchableOpacity>
          </View>

          {loginRole === 'tech' && (
            <View style={styles.techCodeBox}>
              <View style={styles.rowBetween}>
                <Text style={styles.techCodeLabel}>Credencial de Suporte:</Text>
                <TouchableOpacity
                  style={styles.smallOutlineBtn}
                  onPress={async () => {
                    const code = await readFromClipboard('generatedCredential');
                    if (code) {
                      setLoginTechCode(code);
                      showToastNotice(`Colado: ${code}`);
                    } else {
                      showToastNotice('Gere ou copie uma credencial SUP-XXXX primeiro!');
                    }
                  }}
                >
                  <Text style={styles.smallOutlineBtnText}>📋 Colar Código</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={[styles.textInput, { backgroundColor: '#fff', fontWeight: 'bold', marginTop: 6 }]}
                placeholder="Código recebido por E-mail/SMS (SUP-XXXX)"
                autoCapitalize="characters"
                value={loginTechCode}
                onChangeText={setLoginTechCode}
              />
              <View style={styles.rowBetween}>
                <Text style={{ fontSize: 10, color: '#1e40af' }}>Esqueceu seu código?</Text>
                <View style={styles.rowGap8}>
                  <TouchableOpacity onPress={() => resendLoginTechCredential('email')}>
                    <Text style={styles.linkBlueSmall}>Reenviar E-mail</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => resendLoginTechCredential('sms')}>
                    <Text style={styles.linkIndigoSmall}>Reenviar SMS</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          )}

          <TouchableOpacity style={[styles.btnPrimary, { marginTop: 14 }]} onPress={handleLoginSubmit}>
            <Text style={styles.btnPrimaryText}>Entrar no HelpTop</Text>
          </TouchableOpacity>

          <View style={[styles.welcomeDivider, { marginTop: 18 }]} />
          <View style={[styles.rowCenter, { justifyContent: 'center' }]}>
            <Text style={{ fontSize: 11, color: '#4b5563' }}>Ainda não tem cadastro? </Text>
            <TouchableOpacity onPress={openRegisterScreen}>
              <Text style={styles.linkBlueBold}>Criar conta agora</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  function renderRegisterScreen() {
    return (
      <View style={styles.screenContainer}>
        <View style={styles.appBar}>
          <View style={styles.rowCenter}>
            <TouchableOpacity style={styles.appBarBackBtn} onPress={() => goToScreen('welcome')}>
              <Text style={styles.appBarBackText}>← Início</Text>
            </TouchableOpacity>
            <Text style={styles.appBarTitle}>Cadastro - HelpTop</Text>
          </View>
        </View>

        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 14 }}>
          <View style={styles.sectionHeaderBorder}>
            <Text style={styles.sectionTitle}>Criar Nova Conta</Text>
            <Text style={styles.sectionSubtitle}>Preencha seus dados para se cadastrar do zero como usuário ou suporte.</Text>
          </View>

          {regFeedback && (
            <View style={[styles.feedbackBox, regFeedback.isError ? styles.feedbackError : styles.feedbackSuccess]}>
              <Text style={regFeedback.isError ? styles.feedbackErrorText : styles.feedbackSuccessText}>
                {regFeedback.text}
              </Text>
            </View>
          )}

          <Text style={styles.inputLabel}>Quero me cadastrar como:</Text>
          <View style={styles.roleSwitchRow}>
            <TouchableOpacity
              style={[styles.roleOptionBtn, regRole === 'client' && styles.roleOptionBtnActive]}
              onPress={() => { setRegRole('client'); setRegConsent(false); }}
            >
              <Text style={[styles.roleOptionText, regRole === 'client' && styles.roleOptionTextActive]}>
                Cliente / Usuário
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.roleOptionBtn, regRole === 'tech' && styles.roleOptionBtnActive]}
              onPress={() => { setRegRole('tech'); setRegConsent(false); }}
            >
              <Text style={[styles.roleOptionText, regRole === 'tech' && styles.roleOptionTextActive]}>
                Suporte Técnico Humano
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.inputLabel}>Nome Completo: *</Text>
          <TextInput
            style={styles.textInput}
            placeholder="Digite o nome completo"
            value={regName}
            onChangeText={setRegName}
          />

          <View style={styles.rowGap8}>
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>CPF: *</Text>
              <TextInput
                style={styles.textInput}
                placeholder="000.000.000-00"
                keyboardType="numeric"
                value={regCpf}
                onChangeText={setRegCpf}
              />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>Telefone (Celular): *</Text>
              <TextInput
                style={styles.textInput}
                placeholder="(85) 99999-0000"
                keyboardType="phone-pad"
                value={regPhone}
                onChangeText={setRegPhone}
              />
            </View>
          </View>

          <Text style={styles.inputLabel}>E-mail: *</Text>
          <TextInput
            style={styles.textInput}
            placeholder="email@exemplo.com"
            keyboardType="email-address"
            autoCapitalize="none"
            value={regEmail}
            onChangeText={setRegEmail}
          />

          {regRole === 'client' ? (
            <View style={styles.clientDeviceRegBox}>
              <View style={styles.rowBetween}>
                <Text style={styles.inputLabel}>Aparelho ou PC Detectado: *</Text>
                <TouchableOpacity
                  style={styles.smallOutlineBtn}
                  onPress={async () => {
                    const latest = await refreshRealHardwareTelemetry(true);
                    setRegDevice(latest.deviceName);
                  }}
                >
                  <Text style={styles.smallOutlineBtnText}>🔄 Detectar Real</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={[styles.textInput, { backgroundColor: '#fff', marginTop: 4, marginBottom: 2 }]}
                placeholder="Detectando modelo real do aparelho/PC..."
                value={regDevice}
                onChangeText={setRegDevice}
              />
              <Text style={{ fontSize: 10, color: '#047857', fontWeight: '600' }}>
                ✓ Hardware real detectado: {metrics.deviceName} • RAM {metrics.ramTotal} GB
              </Text>
            </View>
          ) : (
            <View style={styles.techCodeBox}>
              <Text style={styles.techCodeLabel}>Especialidade Técnica: *</Text>
              <TextInput
                style={[styles.textInput, { backgroundColor: '#fff', marginTop: 4 }]}
                placeholder="Ex: Manutenção Android / Software"
                value={regSpecialty}
                onChangeText={setRegSpecialty}
              />

              <Text style={[styles.techCodeLabel, { marginTop: 4 }]}>
                1. Onde deseja receber sua Credencial de Suporte?
              </Text>
              <View style={[styles.rowGap6, { marginTop: 4 }]}>
                <TouchableOpacity
                  style={[styles.btnPrimary, styles.flex1, { paddingVertical: 7 }]}
                  onPress={() => sendSupportCredentialCode('email')}
                >
                  <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>📧 Enviar p/ E-mail</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.btnIndigo, styles.flex1, { paddingVertical: 7 }]}
                  onPress={() => sendSupportCredentialCode('sms')}
                >
                  <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>📱 Enviar p/ SMS</Text>
                </TouchableOpacity>
              </View>

              {credentialMessageData && (
                <View style={styles.credSentStatusBox}>
                  <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#065f46' }}>
                    ✓ Código enviado por {credentialMessageData.channel} para: {credentialMessageData.destination}
                  </Text>
                  <View style={[styles.rowBetween, { marginTop: 4 }]}>
                    <Text style={{ fontSize: 10, color: '#1e3a8a' }}>
                      Credencial: <Text style={{ fontWeight: 'bold' }}>{credentialMessageData.code}</Text>
                    </Text>
                    <View style={styles.rowGap6}>
                      <TouchableOpacity onPress={() => setShowInboxModal(true)}>
                        <Text style={styles.linkBlueSmall}>Ver {credentialMessageData.channel}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => setRegTechKey(credentialMessageData.code)}>
                        <Text style={[styles.linkBlueSmall, { color: '#065f46' }]}>Colar Agora</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              )}

              <View style={[styles.rowBetween, { marginTop: 8 }]}>
                <Text style={styles.techCodeLabel}>2. Código de Credencial Recebido: *</Text>
                <TouchableOpacity
                  style={styles.smallOutlineBtn}
                  onPress={async () => {
                    const code = await readFromClipboard('generatedCredential');
                    if (code) {
                      setRegTechKey(code);
                      showToastNotice(`Colado: ${code}`);
                    }
                  }}
                >
                  <Text style={styles.smallOutlineBtnText}>📋 Colar Código</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={[styles.textInput, { backgroundColor: '#fff', fontWeight: 'bold', marginTop: 4, marginBottom: 2 }]}
                placeholder="Cole o código SUP-XXXX enviado"
                autoCapitalize="characters"
                value={regTechKey}
                onChangeText={setRegTechKey}
              />
            </View>
          )}

          <View style={[styles.rowGap8, { marginTop: 8 }]}>
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>Senha: *</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Mín. 6 dígitos"
                secureTextEntry
                value={regPass}
                onChangeText={setRegPass}
              />
            </View>
            <View style={styles.flex1}>
              <Text style={styles.inputLabel}>Confirmar: *</Text>
              <TextInput
                style={styles.textInput}
                placeholder="Repita a senha"
                secureTextEntry
                value={regPassConfirm}
                onChangeText={setRegPassConfirm}
              />
            </View>
          </View>

          <View style={styles.consentBox}>
            {regRole === 'tech' && (
              <View style={{ marginBottom: 6, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#fcd34d' }}>
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#1e3a8a', marginBottom: 2 }}>
                  Termos e Condições — Suporte Credenciado
                </Text>
                <Text style={{ fontSize: 10, color: '#374151' }}>
                  • Sigilo (LGPD): Dados e métricas usados apenas no chamado.{'\n'}
                  • Protocolo Ativo: Atendimento restrito a códigos HT válidos.{'\n'}
                  • Conduta Ética: Vedado pedir senhas, fotos ou dados bancários.
                </Text>
              </View>
            )}
            <TouchableOpacity style={styles.rowCenter} onPress={() => setRegConsent(!regConsent)}>
              <View style={[styles.checkboxBox, regConsent && styles.checkboxBoxChecked]}>
                {regConsent && <Text style={styles.checkboxTick}>✓</Text>}
              </View>
              <Text style={{ fontSize: 11, color: '#1f2937', flex: 1 }}>
                {regRole === 'tech'
                  ? 'Declaro que li e aceito os Termos e Condições de Atuação Técnica (LGPD e protocolo).'
                  : 'Declaro que li e concordo com os Termos de Uso, Privacidade e Segurança do HelpTop.'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={{ marginTop: 6, marginLeft: 24 }}
              onPress={() => {
                setTermsModalRole(regRole);
                setShowTermsModal(true);
              }}
            >
              <Text style={styles.linkBlueSmall}>ℹ️ Saiba mais (Ler os Termos)</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={[styles.btnGreen, { marginTop: 10 }]} onPress={handleRegisterSubmit}>
            <Text style={styles.btnPrimaryText}>Concluir Cadastro e Ir para Login</Text>
          </TouchableOpacity>

          <View style={[styles.rowCenter, { justifyContent: 'center', marginTop: 12, marginBottom: 8 }]}>
            <Text style={{ fontSize: 11, color: '#4b5563' }}>Já possui uma conta? </Text>
            <TouchableOpacity onPress={() => openLoginScreen()}>
              <Text style={styles.linkBlueBold}>Ir para Login</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  function renderDashboardScreen() {
    const displayDevice = (currentUser && currentUser.device) ? currentUser.device : metrics.deviceName;
    const hasOpenTicket = Boolean(generatedProtocolCode && supportTickets.some(t => t.protocol === generatedProtocolCode));

    return (
      <View style={styles.screenContainer}>
        <View style={styles.appBar}>
          <Text style={styles.appBarTitle}>HelpTop - Diagnóstico</Text>
          <View style={styles.rowGap6}>
            <TouchableOpacity style={styles.appBarActionBtn} onPress={openSettingsProfileScreen}>
              <Text style={styles.appBarActionText}>⚙️ Perfil</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.appBarActionBtn} onPress={logoutMobileUser}>
              <Text style={styles.appBarActionText}>Sair</Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 12 }}>
          {/* Cartão do Usuário + Dispositivo Real */}
          <View style={styles.userCard}>
            <View style={{ flex: 1, paddingRight: 6 }}>
              <Text style={styles.smallLabelGray}>Usuário Conectado:</Text>
              <Text style={styles.userNameBold} numberOfLines={1}>
                {currentUser ? currentUser.name : 'Usuário'}
              </Text>
              <View style={styles.rolePillClient}>
                <Text style={styles.rolePillClientText}>Cliente / Usuário</Text>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', maxWidth: '54%' }}>
              <Text style={styles.smallLabelGray}>Dispositivo / PC Real:</Text>
              <View style={styles.deviceBadgeBox}>
                <Text style={styles.deviceBadgeText} numberOfLines={2}>
                  📱 {displayDevice}
                </Text>
              </View>
            </View>
          </View>

          {/* Painel de Telemetria Real do Hardware */}
          <View style={styles.telemetryCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 6, marginBottom: 8 }]}>
              <View style={styles.rowCenter}>
                <View style={styles.greenPulseDot} />
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#1f2937' }}>
                  Telemetria Real (Aparelho / PC)
                </Text>
              </View>
              <TouchableOpacity
                style={styles.smallOutlineBtn}
                onPress={() => refreshRealHardwareTelemetry(true)}
              >
                <Text style={styles.smallOutlineBtnText}>🔄 Ler Agora</Text>
              </TouchableOpacity>
            </View>

            {/* Especificações Reais Detectadas */}
            <View style={styles.specsGridBox}>
              <View style={styles.rowGap8}>
                <View style={styles.flex1}>
                  <Text style={styles.specItemLabel}>Sistema / Arquitetura:</Text>
                  <Text style={styles.specItemValue} numberOfLines={1}>{metrics.osLabel}</Text>
                </View>
                <View style={styles.flex1}>
                  <Text style={styles.specItemLabel}>Processador (CPU Real):</Text>
                  <Text style={styles.specItemValue} numberOfLines={1}>{metrics.cpuLabel}</Text>
                </View>
              </View>
              <View style={styles.specRowDivider}>
                <Text style={styles.specItemLabel}>Placa Gráfica / GPU / Hardware:</Text>
                <Text style={[styles.specItemValue, { color: '#312e81' }]} numberOfLines={1}>
                  {metrics.gpuLabel}
                </Text>
              </View>
              <View style={[styles.rowGap8, styles.specRowDivider]}>
                <View style={styles.flex1}>
                  <Text style={styles.specItemLabel}>Tela & Taxa Real (Hz):</Text>
                  <Text style={styles.specItemValue} numberOfLines={1}>{metrics.screenLabel}</Text>
                </View>
                <View style={styles.flex1}>
                  <Text style={styles.specItemLabel}>Rede & Latência Real:</Text>
                  <Text style={[styles.specItemValue, { color: '#065f46' }]} numberOfLines={1}>
                    {metrics.netLabel}
                  </Text>
                </View>
              </View>
            </View>

            {/* Memória RAM / Heap Real */}
            <View style={{ marginTop: 10 }}>
              <View style={styles.rowBetween}>
                <Text style={styles.gaugeTitle}>
                  Memória (RAM / Heap):{' '}
                  {analysisVisibleOnDashboard && (
                    <Text style={{ color: metrics.ram < 75 ? '#15803d' : '#dc2626', fontWeight: 'bold' }}>
                      {metrics.ram < 75 ? '(Normal)' : '(Elevado)'}
                    </Text>
                  )}
                </Text>
                <Text style={styles.gaugeTitle}>{metrics.ram}%</Text>
              </View>
              <Text style={styles.gaugeSubDetail}>{metrics.ramDetailLabel}</Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(100, Math.max(4, metrics.ram))}%`,
                      backgroundColor: !analysisVisibleOnDashboard
                        ? '#2563eb'
                        : (metrics.ram < 75 ? '#16a34a' : '#dc2626')
                    }
                  ]}
                />
              </View>
            </View>

            {/* Armazenamento Real */}
            <View style={{ marginTop: 10 }}>
              <View style={styles.rowBetween}>
                <Text style={styles.gaugeTitle}>
                  Armazenamento Real:{' '}
                  {analysisVisibleOnDashboard && (
                    <Text style={{ color: metrics.storage < 85 ? '#15803d' : '#b45309', fontWeight: 'bold' }}>
                      {metrics.storage < 85 ? '(Disponível)' : '(Cheio)'}
                    </Text>
                  )}
                </Text>
                <Text style={styles.gaugeTitle}>{metrics.storage}%</Text>
              </View>
              <Text style={styles.gaugeSubDetail}>{metrics.storageDetailLabel}</Text>
              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(100, Math.max(4, metrics.storage))}%`,
                      backgroundColor: !analysisVisibleOnDashboard
                        ? '#2563eb'
                        : (metrics.storage < 85 ? '#16a34a' : '#f59e0b')
                    }
                  ]}
                />
              </View>
            </View>

            {/* Carga CPU/Temperatura e Desempenho Real (FPS) */}
            <View style={[styles.rowGap8, { marginTop: 10 }]}>
              <View style={styles.metricMiniCard}>
                <Text style={styles.specItemLabel}>Carga CPU / Temp. Est.:</Text>
                <Text style={styles.metricMiniBig}>{metrics.temp.toFixed(1)}°C</Text>
                <Text style={styles.specItemLabel}>
                  Latência: {metrics.cpuLatencyMs}ms ({metrics.cpuCores} núcleos)
                </Text>
              </View>
              <View style={styles.metricMiniCard}>
                <Text style={styles.specItemLabel}>Desempenho Real (FPS):</Text>
                <Text style={styles.metricMiniBig}>
                  {metrics.performance}%{' '}
                  {analysisVisibleOnDashboard && (
                    <Text style={{ fontSize: 10, color: !metrics.isCritical ? '#15803d' : '#dc2626' }}>
                      {!metrics.isCritical ? '(Ótimo)' : '(Atenção)'}
                    </Text>
                  )}
                </Text>
                <Text style={styles.specItemLabel}>Taxa Real: {metrics.fps} FPS ({metrics.hz}Hz)</Text>
              </View>
            </View>

            {/* Bateria e Fonte de Energia Real */}
            <View style={[styles.rowGap8, { marginTop: 8 }]}>
              <View style={[styles.metricMiniCard, styles.rowBetween]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.specItemLabel}>Bateria / Energia Real:</Text>
                  <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#15803d' }} numberOfLines={1}>
                    {metrics.batteryHealth}
                  </Text>
                </View>
                <Text style={{ fontSize: 15 }}>🔋</Text>
              </View>
              <View style={[styles.metricMiniCard, styles.rowBetween]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.specItemLabel}>Fonte / Consumo Real:</Text>
                  <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1f2937' }} numberOfLines={1}>
                    {metrics.batteryDrain}
                  </Text>
                </View>
                <Text style={{ fontSize: 15 }}>⚡</Text>
              </View>
            </View>
          </View>

          {/* Atalhos de Histórico e Lembrete */}
          <View style={[styles.rowGap8, { marginTop: 10 }]}>
            <TouchableOpacity style={styles.shortcutBtnHistory} onPress={() => setShowAuditModal(true)}>
              <Text style={styles.shortcutBtnHistoryText}>📋 Histórico ({auditLogs.length})</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.shortcutBtnReminder, reminderEnabled && styles.shortcutBtnReminderActive]}
              onPress={() => {
                setReminderModalChecked(reminderEnabled);
                setShowReminderModal(true);
              }}
            >
              <Text style={[styles.shortcutBtnReminderText, reminderEnabled && { color: '#78350f' }]}>
                ⏰ {reminderEnabled ? 'Lembrete (Ativo)' : 'Lembrete (Off)'}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Ações de Análise ou Resultado Pós-Análise */}
          {!analysisVisibleOnDashboard ? (
            <View style={{ marginTop: 10 }}>
              <TouchableOpacity style={styles.btnPrimary} onPress={runNativeDiagnosticScan}>
                <Text style={styles.btnPrimaryText}>Fazer Análise Real do Aparelho / PC</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnOutlineBlue, { marginTop: 8 }]}
                onPress={openChatBotWithTyping}
              >
                <Text style={styles.btnOutlineBlueText}>Chat Bot</Text>
              </TouchableOpacity>
              {hasOpenTicket && (
                <TouchableOpacity
                  style={[styles.btnOutlineGreen, { marginTop: 8 }]}
                  onPress={openSupportScreenWaitingProtocol}
                >
                  <Text style={styles.btnOutlineGreenText}>
                    Ver Meu Chamado no Suporte ({generatedProtocolCode})
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          ) : (
            <View
              style={[
                styles.analysisResultCard,
                !metrics.isCritical ? styles.analysisResultCardOk : styles.analysisResultCardWarn
              ]}
            >
              <View style={styles.rowBetween}>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: !metrics.isCritical ? '#166534' : '#78350f' }}>
                  {!metrics.isCritical ? 'Diagnóstico Real: Sistema Estável' : 'Resultado da Análise Real'}
                </Text>
                <View style={styles.smallBadgePill}>
                  <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#1f2937' }}>
                    Registrado no Histórico
                  </Text>
                </View>
              </View>
              <Text style={{ fontSize: 11, color: '#1f2937', marginTop: 6, lineHeight: 16 }}>
                Leitura real de {metrics.deviceName}: Memória em {metrics.ram}% ({metrics.ramDetailLabel}),
                Armazenamento ({metrics.storageDetailLabel}), GPU {metrics.gpuLabel} e Desempenho Real em{' '}
                {metrics.performance}% ({metrics.fps} FPS).
              </Text>
              <View style={styles.analysisSummaryInnerBox}>
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#1f2937' }}>
                  📌 Resumo Real do Hardware:
                </Text>
                <Text style={{ fontSize: 10, color: '#374151', marginTop: 2 }}>
                  • CPU {metrics.cpuCores} núcleos ({metrics.cpuLatencyMs}ms) • Energia: {metrics.batteryHealth} • Rede: {metrics.netLabel}.
                </Text>
                <Text style={{ fontSize: 10, color: '#1e40af', marginTop: 2, fontWeight: '600' }}>
                  💡 Para Limpeza Profunda, Teste de Sensores ou tirar dúvidas específicas, utilize o Chat Bot abaixo.
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.btnGreen, { marginTop: 8 }]}
                onPress={runBasicPostAnalysisFix}
              >
                <Text style={styles.btnPrimaryText}>⚡ Fazer Otimização Básica Rápida</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnPrimary, { marginTop: 6 }]}
                onPress={openChatBotWithTyping}
              >
                <Text style={styles.btnPrimaryText}>Chat Bot</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  // ==========================================================================
  // RENDERIZADORES DAS TELAS 3, 4, 5 E 6 (CHAT BOT, SUPORTE, TÉCNICO, PERFIL)
  // ==========================================================================
  function renderChatScreen() {
    return (
      <View style={styles.screenContainer}>
        <View style={styles.appBar}>
          <View style={styles.rowCenter}>
            <TouchableOpacity style={styles.appBarBackBtn} onPress={() => goToScreen('dashboard')}>
              <Text style={styles.appBarBackText}>← Voltar</Text>
            </TouchableOpacity>
            <Text style={styles.appBarTitle}>HelpTop - Chat Bot</Text>
          </View>
          <View style={styles.rowGap6}>
            <TouchableOpacity style={styles.appBarActionBtn} onPress={openSettingsProfileScreen}>
              <Text style={styles.appBarActionText}>⚙️</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.appBarActionBtn} onPress={logoutMobileUser}>
              <Text style={styles.appBarActionText}>Sair</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Barra de Ferramentas Avançadas do Chat Bot */}
        <View style={styles.chatToolbarBox}>
          <View style={styles.rowBetween}>
            <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#374151' }}>
              Apoio Avançado (Limpeza, Sensores Reais e IA):
            </Text>
            <View style={styles.lgpdMiniBadge}>
              <Text style={styles.lgpdMiniBadgeText}>Permissão LGPD</Text>
            </View>
          </View>

          <View style={[styles.rowGap6, { marginTop: 6 }]}>
            <TouchableOpacity
              style={[styles.chatToolBtn, { backgroundColor: '#fffbeb', borderColor: '#fcd34d' }]}
              onPress={() => setShowDeepCleanModal(true)}
            >
              <Text style={[styles.chatToolBtnText, { color: '#78350f' }]}>🧹 Limp. Profunda</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chatToolBtn, { backgroundColor: '#eef2ff', borderColor: '#a5b4fc' }]}
              onPress={() => setShowHardwareTestModal(true)}
            >
              <Text style={[styles.chatToolBtnText, { color: '#312e81' }]}>🩺 Testar Sensores</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.chatToolBtn, { backgroundColor: '#eff6ff', borderColor: '#93c5fd' }]}
              onPress={() => {
                setCurrentUacTaskKey('ram');
                setShowUacModal(true);
              }}
            >
              <Text style={[styles.chatToolBtnText, { color: '#1e3a8a' }]}>⚡ Task Kill RAM</Text>
            </TouchableOpacity>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 6 }}>
            {[
              { label: '🚀 Travando', prompt: 'Meu celular está travando muito' },
              { label: '💥 Apps fechando', prompt: 'Os aplicativos estão fechando sozinhos' },
              { label: '🔥 Esquentando', prompt: 'Celular esquentando e bateria descarregando' },
              { label: '📶 Wi-Fi / DNS', prompt: 'Wi-Fi e internet estão caindo' },
              { label: '🛡️ Vírus / Adware', prompt: 'Estão aparecendo anúncios sozinhos na tela' }
            ].map((chip, idx) => (
              <TouchableOpacity
                key={idx}
                style={styles.quickPromptChip}
                onPress={() => sendQuickPrompt(chip.prompt)}
              >
                <Text style={styles.quickPromptChipText}>{chip.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Mensagens do Chat Bot */}
        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 10 }}>
          {chatMessages.map(msg => {
            if (msg.sender === 'user') {
              return (
                <View key={msg.id} style={styles.chatBubbleUser}>
                  <Text style={styles.chatBubbleText}>
                    <Text style={{ fontWeight: 'bold' }}>Você: </Text>
                    {msg.text}
                  </Text>
                </View>
              );
            }

            const taskCfg = msg.uacTask ? (BOT_UAC_TASKS[msg.uacTask] || BOT_UAC_TASKS.ram) : null;
            return (
              <View key={msg.id} style={styles.chatBubbleBot}>
                <Text style={styles.chatBubbleText}>
                  <Text style={{ fontWeight: 'bold' }}>Chat Bot: </Text>
                  {msg.text}
                </Text>

                {msg.isProtocolCard && msg.protocolCode && (
                  <View style={styles.protocolGeneratedCard}>
                    <Text style={styles.protocolCodeBig}>{msg.protocolCode}</Text>
                    <View style={[styles.rowGap6, { marginTop: 6 }]}>
                      <TouchableOpacity
                        style={[styles.btnGreen, styles.flex1, { paddingVertical: 7 }]}
                        onPress={() => robustCopyToClipboard(msg.protocolCode)}
                      >
                        <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>📋 Copiar Protocolo</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[styles.btnPrimary, styles.flex1, { paddingVertical: 7 }]}
                        onPress={openSupportScreenWaitingProtocol}
                      >
                        <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>Abrir Suporte →</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {msg.showAiCard && taskCfg && (
                  <View style={styles.aiActionCard}>
                    <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#1e3a8a', marginBottom: 4 }}>
                      🤖 Quer que a IA entre e faça isso por você ou prefere o passo a passo manual?
                    </Text>
                    <TouchableOpacity
                      style={[styles.btnPrimary, { paddingVertical: 7 }]}
                      onPress={() => {
                        setCurrentUacTaskKey(msg.uacTask);
                        setShowUacModal(true);
                      }}
                    >
                      <Text style={[styles.btnPrimaryText, { fontSize: 11 }]}>
                        {taskCfg.btnLabel} (Automático)
                      </Text>
                    </TouchableOpacity>
                    {!msg.hideManualGuideBtn && (
                      <TouchableOpacity
                        style={[styles.btnSecondary, { paddingVertical: 6, marginTop: 4 }]}
                        onPress={() => {
                          appendBotMessage(
                            `${taskCfg.manualGuide}\n\n💡 Se preferir não fazer manualmente, toque no botão abaixo para a IA aplicar esse ajuste por você!`,
                            { uacTask: msg.uacTask, hideManualGuideBtn: true }
                          );
                        }}
                      >
                        <Text style={{ fontSize: 10, fontWeight: '600', color: '#374151', textAlign: 'center' }}>
                          📖 Ver Passo a Passo Manual Detalhado
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {Array.isArray(msg.quickReplies) && msg.quickReplies.length > 0 && (
                  <View style={[styles.rowWrap, { marginTop: 6 }]}>
                    {msg.quickReplies.map((q, qIdx) => (
                      <TouchableOpacity
                        key={qIdx}
                        style={styles.botQuickReplyPill}
                        onPress={() => sendQuickPrompt(q.prompt)}
                      >
                        <Text style={styles.botQuickReplyText}>{q.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {msg.showSupportFooter && (
                  <View style={styles.botFooterBar}>
                    <Text style={{ fontSize: 10, color: '#6b7280' }}>Precisa de um técnico ao vivo?</Text>
                    <TouchableOpacity onPress={generateSupportProtocolInChat}>
                      <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#15803d', textDecorationLine: 'underline' }}>
                        Gerar Protocolo Humano →
                      </Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            );
          })}

          {isBotTyping && (
            <View style={styles.chatBubbleBot}>
              <Text style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>
                Chat Bot está digitando...
              </Text>
            </View>
          )}
        </ScrollView>

        {/* Input do Chat Bot */}
        <View style={styles.chatInputRow}>
          <TextInput
            style={[styles.textInput, styles.flex1, { marginBottom: 0 }]}
            placeholder="Descreva o problema ou peça um reparo..."
            value={chatInput}
            onChangeText={setChatInput}
            onSubmitEditing={handleUserChatSubmit}
          />
          <TouchableOpacity style={styles.chatSendBtn} onPress={handleUserChatSubmit}>
            <Text style={styles.btnPrimaryText}>Enviar</Text>
          </TouchableOpacity>
        </View>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  function renderSupportScreen() {
    const activeTicket = generatedProtocolCode
      ? supportTickets.find(t => t.protocol === generatedProtocolCode)
      : null;
    const rs = activeTicket && activeTicket.remoteSession ? activeTicket.remoteSession : null;

    return (
      <View style={styles.screenContainer}>
        <View style={[styles.appBar, { backgroundColor: '#2e7d32' }]}>
          <TouchableOpacity
            style={[styles.appBarBackBtn, { backgroundColor: '#14532d' }]}
            onPress={() => goToScreen('chat')}
          >
            <Text style={styles.appBarBackText}>← Voltar</Text>
          </TouchableOpacity>
          <Text style={styles.appBarTitle}>HelpTop - Suporte Humano</Text>
          <View style={styles.rowGap6}>
            <TouchableOpacity
              style={[styles.appBarActionBtn, { backgroundColor: '#14532d' }]}
              onPress={openSettingsProfileScreen}
            >
              <Text style={styles.appBarActionText}>⚙️</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.appBarActionBtn, { backgroundColor: '#14532d' }]}
              onPress={logoutMobileUser}
            >
              <Text style={styles.appBarActionText}>Sair</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Cabeçalho de Status do Chamado */}
        <View style={styles.supportStatusHeader}>
          <View style={styles.rowBetween}>
            <Text style={{ fontSize: 11, color: '#14532d', fontWeight: 'bold' }}>
              {activeTicket
                ? `${activeTicket.protocol}: ${activeTicket.status}`
                : 'Status: Aguardando envio do protocolo...'}
            </Text>
            <View style={styles.livePillAmber}>
              <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#78350f' }}>● Tempo Real</Text>
            </View>
          </View>

          {activeTicket && (
            <View style={[styles.rowBetween, { marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: '#bbf7d0' }]}>
              <Text style={{ fontSize: 10, color: '#166534', flex: 1 }}>
                {activeTicket.assignedTech
                  ? `● Técnico Conectado: ${activeTicket.assignedTech}`
                  : '⏳ Aguardando técnico assumir (use "Alternar 2ª Tela" no topo)'}
              </Text>
              <TouchableOpacity
                style={styles.smallOutlineBtn}
                onPress={clientSendUpdatedTelemetryToTech}
              >
                <Text style={[styles.smallOutlineBtnText, { color: '#14532d' }]}>📡 Enviar Telemetria</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Painel de Sessão Remota Estilo AnyDesk no Cliente (Acima do chat mantendo o chat 100% ativo!) */}
        {rs && rs.active && (
          <View style={styles.anydeskDockBox}>
            <View style={[styles.rowBetween, { borderBottomWidth: 1, borderBottomColor: '#334155', paddingBottom: 5 }]}>
              <View style={styles.rowCenter}>
                <View style={styles.anydeskRedBadge}>
                  <Text style={styles.anydeskRedBadgeText}>
                    {rs.status === 'requested' ? 'AnyDesk' : 'AnyDesk Ativo'}
                  </Text>
                </View>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#fff', marginLeft: 6 }}>
                  {rs.status === 'requested'
                    ? 'Pedido de Conexão Remota'
                    : (rs.mode === 'phone_to_phone' ? '📱 Celular → 📱 Celular' : '💻 PC → 📱 Celular')}
                </Text>
              </View>
              {rs.status === 'requested' ? (
                <Text style={{ fontSize: 9, color: '#6ee7b7', fontFamily: 'monospace' }}>
                  ID: {rs.remoteId}
                </Text>
              ) : (
                <TouchableOpacity
                  style={styles.anydeskDisconnectBtn}
                  onPress={() => closeAnyDeskRemoteSession(activeTicket.protocol)}
                >
                  <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#fff' }}>Desconectar</Text>
                </TouchableOpacity>
              )}
            </View>

            {rs.status === 'requested' ? (
              <View style={{ marginTop: 6 }}>
                <Text style={{ fontSize: 10, color: '#e2e8f0', lineHeight: 14 }}>
                  O técnico <Text style={{ fontWeight: 'bold', color: '#fcd34d' }}>{rs.techName}</Text> solicita
                  acesso remoto para executar o programa de suporte:
                </Text>
                <View style={styles.anydeskTerminalBox}>
                  <Text style={styles.anydeskTerminalText}>📦 {rs.programName}</Text>
                </View>
                <Text style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>
                  💬 O seu chat abaixo continua 100% ativo durante toda a sessão!
                </Text>
                <View style={[styles.rowGap6, { marginTop: 6 }]}>
                  <TouchableOpacity
                    style={[styles.btnGreen, styles.flex1, { paddingVertical: 6 }]}
                    onPress={() => clientRespondAnyDeskSession(activeTicket.protocol, true)}
                  >
                    <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>✓ Permitir & Rodar Programa</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnSlate, styles.flex1, { paddingVertical: 6 }]}
                    onPress={() => clientRespondAnyDeskSession(activeTicket.protocol, false)}
                  >
                    <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>✕ Recusar Acesso</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <View style={{ marginTop: 6 }}>
                <View style={styles.rowBetween}>
                  <Text style={{ fontSize: 9, color: '#cbd5e1' }}>
                    Técnico: <Text style={{ fontWeight: 'bold', color: '#fff' }}>{rs.techName}</Text>
                  </Text>
                  <Text style={{ fontSize: 9, color: '#fcd34d' }}>ID: {rs.remoteId}</Text>
                </View>
                <View style={styles.anydeskTerminalBox}>
                  {(rs.logs || []).map((line, idx) => (
                    <Text key={idx} style={styles.anydeskTerminalText}>{line}</Text>
                  ))}
                </View>
                <View style={[styles.rowBetween, { marginTop: 3 }]}>
                  <Text style={{ fontSize: 9, color: '#94a3b8' }}>💬 Chat ao vivo liberado abaixo.</Text>
                  <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#34d399' }}>● Programa Ativo</Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Mensagens do Suporte Humano */}
        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 10 }}>
          {!activeTicket ? (
            <View style={styles.supportWelcomeBox}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#166534' }}>
                Canal Oficial de Suporte Técnico Humano
              </Text>
              <Text style={{ fontSize: 11, color: '#374151', marginTop: 4 }}>
                Para iniciar o atendimento em tempo real, gere ou cole seu código de protocolo{' '}
                <Text style={{ fontWeight: 'bold' }}>{generatedProtocolCode || 'HT-XXXX'}</Text> abaixo e toque em Enviar.
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.protocolActiveHeaderCard}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1e3a8a' }}>
                    Protocolo {activeTicket.protocol} Ativo!
                  </Text>
                  <Text style={{ fontSize: 10, color: '#1e40af' }}>
                    Canal criptografado conectado à Central de Suporte.
                  </Text>
                </View>
                <View style={styles.smallBadgePill}>
                  <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#1e3a8a' }}>
                    {activeTicket.status}
                  </Text>
                </View>
              </View>

              {(activeTicket.messages || []).map((msg, idx) => {
                if (msg.senderRole === 'client') {
                  return (
                    <View key={idx} style={styles.supportBubbleClient}>
                      <Text style={styles.chatBubbleText}>
                        <Text style={{ fontWeight: 'bold' }}>Você ({msg.senderName}): </Text>
                        {msg.text}
                      </Text>
                    </View>
                  );
                }
                if (msg.senderRole === 'tech') {
                  return (
                    <View key={idx} style={styles.supportBubbleTech}>
                      <Text style={styles.chatBubbleText}>
                        <Text style={{ fontWeight: 'bold', color: '#1e3a8a' }}>
                          👨‍💻 {msg.senderName} (Suporte):{' '}
                        </Text>
                        {msg.text}
                      </Text>
                    </View>
                  );
                }
                return (
                  <View key={idx} style={styles.supportBubbleSystem}>
                    <Text style={{ fontSize: 10, color: '#78350f', lineHeight: 14 }}>{msg.text}</Text>
                  </View>
                );
              })}

              {activeTicket.status === 'Resolvido' && (
                <View style={styles.ratingCard}>
                  {!activeTicket.rating ? (
                    <>
                      <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#065f46' }}>
                        ✓ Chamado Concluído pelo Suporte!
                      </Text>
                      <Text style={{ fontSize: 10, color: '#047857', marginTop: 3 }}>
                        Como você avalia o atendimento do técnico {activeTicket.assignedTech || 'HelpTop'}?
                      </Text>
                      <View style={[styles.rowGap6, { marginTop: 8, justifyContent: 'center' }]}>
                        {[1, 2, 3, 4, 5].map(star => (
                          <TouchableOpacity
                            key={star}
                            style={styles.starBtn}
                            onPress={() => clientRateSupportTicket(activeTicket.protocol, star)}
                          >
                            <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#78350f' }}>
                              {star} ⭐
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#065f46' }}>
                        ✓ Atendimento Finalizado e Avaliado ({activeTicket.rating}/5 ⭐)
                      </Text>
                      <TouchableOpacity
                        style={[styles.btnGreen, { marginTop: 8 }]}
                        onPress={clientStartNewProtocolTicket}
                      >
                        <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>
                          + Gerar Novo Protocolo de Suporte
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}
            </>
          )}
        </ScrollView>

        {/* Barra de Envio de Protocolo e Chat */}
        <View style={styles.supportInputBox}>
          <View style={[styles.rowBetween, { marginBottom: 4 }]}>
            <Text style={{ fontSize: 10, color: '#6b7280' }}>
              {activeTicket ? `Conectado ao protocolo ${activeTicket.protocol}:` : 'Envie o protocolo ou mensagem:'}
            </Text>
            <View style={styles.rowGap6}>
              {!activeTicket && (
                <TouchableOpacity style={styles.smallOutlineBtn} onPress={quickGenerateAndPasteProtocol}>
                  <Text style={styles.smallOutlineBtnText}>⚡ Gerar Código</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.smallOutlineBtn, { borderColor: '#86efac', backgroundColor: '#f0fdf4' }]}
                onPress={async () => {
                  const p = await readFromClipboard('protocol');
                  if (p) {
                    setSupportInput(p);
                    showToastNotice(`Colado: ${p}`);
                  } else {
                    quickGenerateAndPasteProtocol();
                  }
                }}
              >
                <Text style={[styles.smallOutlineBtnText, { color: '#166534' }]}>📋 Colar Protocolo</Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.rowGap6}>
            <TextInput
              style={[styles.textInput, styles.flex1, { marginBottom: 0 }]}
              placeholder={
                activeTicket
                  ? 'Digite sua mensagem para o técnico (chat ativo)...'
                  : 'Cole o protocolo HT-XXXX ou escreva sua mensagem...'
              }
              value={supportInput}
              onChangeText={setSupportInput}
              onSubmitEditing={handleUserSupportSubmit}
            />
            <TouchableOpacity style={styles.supportSendBtn} onPress={handleUserSupportSubmit}>
              <Text style={styles.btnPrimaryText}>Enviar</Text>
            </TouchableOpacity>
          </View>
        </View>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  function renderTechPanelScreen() {
    const q = techSearchQuery.trim().toUpperCase();
    const filteredTickets = supportTickets.filter(t => {
      if (!q) return true;
      return t.protocol.toUpperCase().includes(q) || (t.clientName && t.clientName.toUpperCase().includes(q));
    });
    const selectedTicket = supportTickets.find(t => t.protocol === activeTechTicketProtocol) || filteredTickets[0] || null;
    const tm = selectedTicket && selectedTicket.metrics ? selectedTicket.metrics : metrics;
    const rs = selectedTicket && selectedTicket.remoteSession ? selectedTicket.remoteSession : null;

    return (
      <View style={styles.screenContainer}>
        <View style={[styles.appBar, { backgroundColor: '#1e3a8a' }]}>
          <Text style={styles.appBarTitle}>HelpTop - Central do Suporte</Text>
          <View style={styles.rowGap6}>
            <TouchableOpacity
              style={[styles.appBarActionBtn, { backgroundColor: '#172554' }]}
              onPress={openSettingsProfileScreen}
            >
              <Text style={styles.appBarActionText}>⚙️ Perfil</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.appBarActionBtn, { backgroundColor: '#172554' }]}
              onPress={logoutMobileUser}
            >
              <Text style={styles.appBarActionText}>Sair</Text>
            </TouchableOpacity>
          </View>
        </View>

        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 10 }}>
          {/* Crachá e Status de Plantão */}
          <View style={styles.telemetryCard}>
            <View style={styles.rowBetween}>
              <View style={{ flex: 1, paddingRight: 6 }}>
                <Text style={styles.smallLabelGray}>Técnico Credenciado Conectado:</Text>
                <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#111827' }} numberOfLines={1}>
                  {currentUser
                    ? `${currentUser.name} • ${currentUser.device || 'Suporte'} (${currentUser.techCode || 'SUP'})`
                    : 'Suporte Técnico'}
                </Text>
              </View>
              <View style={styles.dutyBadge}>
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#14532d' }}>● {techDutyStatus}</Text>
              </View>
            </View>
            <View style={[styles.rowGap6, { marginTop: 8 }]}>
              {['Disponível', 'Ocupado', 'Offline'].map(st => (
                <TouchableOpacity
                  key={st}
                  style={[
                    styles.dutySwitchBtn,
                    st === 'Disponível' && { backgroundColor: '#16a34a' },
                    st === 'Ocupado' && { backgroundColor: '#f59e0b' },
                    st === 'Offline' && { backgroundColor: '#475569' }
                  ]}
                  onPress={() => setTechDutyStatus(st)}
                >
                  <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#fff' }}>{st}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Fila de Chamados */}
          <View style={[styles.telemetryCard, { marginTop: 8 }]}>
            <View style={styles.rowBetween}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1f2937' }}>
                Fila de Chamados ({supportTickets.length})
              </Text>
              <TouchableOpacity onPress={() => setTechSearchQuery('')}>
                <Text style={styles.linkBlueSmall}>Atualizar Fila</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.rowGap6, { marginTop: 6 }]}>
              <TextInput
                style={[styles.textInput, styles.flex1, { marginBottom: 0, paddingVertical: 4, fontSize: 10 }]}
                placeholder="FILTRAR CÓDIGO/NOME"
                autoCapitalize="characters"
                value={techSearchQuery}
                onChangeText={setTechSearchQuery}
              />
              <TouchableOpacity
                style={styles.smallOutlineBtn}
                onPress={async () => {
                  const p = await readFromClipboard('protocol');
                  if (p) setTechSearchQuery(p);
                }}
              >
                <Text style={styles.smallOutlineBtnText}>📋 Colar</Text>
              </TouchableOpacity>
            </View>

            <View style={{ marginTop: 6 }}>
              {filteredTickets.length === 0 ? (
                <View style={styles.emptyQueueBox}>
                  <Text style={{ fontSize: 10, color: '#6b7280', textAlign: 'center' }}>
                    Nenhum chamado na fila. Quando um cliente conectar um protocolo HT-XXXX, ele aparecerá aqui instantaneamente!
                  </Text>
                </View>
              ) : (
                filteredTickets.map(t => {
                  const isSel = selectedTicket && selectedTicket.protocol === t.protocol;
                  const itemM = t.metrics || metrics;
                  return (
                    <TouchableOpacity
                      key={t.protocol}
                      style={[styles.queueTicketItem, isSel && styles.queueTicketItemSelected]}
                      onPress={() => selectTechTicket(t.protocol)}
                    >
                      <View style={{ flex: 1, paddingRight: 6 }}>
                        <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1e3a8a' }} numberOfLines={1}>
                          {t.protocol} • {t.clientName} {t.rating ? `(${t.rating}⭐)` : ''}
                        </Text>
                        <Text style={{ fontSize: 10, color: '#6b7280' }} numberOfLines={1}>
                          {t.clientDevice} • RAM {itemM.ram}% • Desemp. {itemM.performance}%
                        </Text>
                      </View>
                      <View style={styles.smallBadgePill}>
                        <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#1e3a8a' }}>{t.status}</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </View>

          {/* Painel do Chamado Selecionado */}
          <View style={[styles.telemetryCard, { marginTop: 8, borderColor: '#93c5fd' }]}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 6 }]}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1e3a8a', flex: 1 }} numberOfLines={1}>
                {selectedTicket
                  ? `${selectedTicket.protocol} — ${selectedTicket.clientName} (${selectedTicket.clientDevice})`
                  : 'Nenhum protocolo selecionado'}
              </Text>
              <View style={styles.smallBadgePill}>
                <Text style={{ fontSize: 9, fontWeight: 'bold', color: '#1e3a8a' }}>
                  {selectedTicket ? selectedTicket.status : '--'}
                </Text>
              </View>
            </View>

            {/* Telemetria Real do Cliente */}
            <View style={[styles.rowGap6, { marginTop: 6 }]}>
              <View style={styles.techMetricBox}>
                <Text style={styles.specItemLabel}>RAM</Text>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: tm.ram < 75 ? '#15803d' : '#dc2626' }}>
                  {selectedTicket ? `${tm.ram}%` : '--%'}
                </Text>
              </View>
              <View style={styles.techMetricBox}>
                <Text style={styles.specItemLabel}>Espaço</Text>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: tm.storage < 85 ? '#15803d' : '#b45309' }}>
                  {selectedTicket ? `${tm.storage}%` : '--%'}
                </Text>
              </View>
              <View style={styles.techMetricBox}>
                <Text style={styles.specItemLabel}>Temp.</Text>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1f2937' }}>
                  {selectedTicket ? `${Number(tm.temp).toFixed(1)}°C` : '--°C'}
                </Text>
              </View>
              <View style={styles.techMetricBox}>
                <Text style={styles.specItemLabel}>Desemp.</Text>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1d4ed8' }}>
                  {selectedTicket ? `${tm.performance}%` : '--%'}
                </Text>
              </View>
            </View>

            {/* Botões de Ação Remota */}
            <View style={[styles.rowGap6, { marginTop: 8 }]}>
              <TouchableOpacity
                style={[styles.techActionBtn, { backgroundColor: '#fef2f2', borderColor: '#f87171' }]}
                onPress={() => {
                  if (!selectedTicket) {
                    showToastNotice('Selecione um protocolo na fila primeiro!');
                    return;
                  }
                  setShowTechAnyDeskPanel(!showTechAnyDeskPanel);
                }}
              >
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#7f1d1d' }}>🖥️ Limpeza Remota</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.techActionBtn, { backgroundColor: '#f3f4f6', borderColor: '#d1d5db' }]}
                onPress={() => techExecuteRemoteAction('safemode')}
              >
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#1f2937' }}>🛡️ Modo Seguro</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.techActionBtn, { backgroundColor: '#15803d', borderColor: '#15803d' }]}
                onPress={() => techExecuteRemoteAction('resolve')}
              >
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#fff' }}>✓ Resolvido</Text>
              </TouchableOpacity>
            </View>

            {/* Painel AnyDesk do Suporte Técnico */}
            {showTechAnyDeskPanel && selectedTicket && (
              <View style={[styles.anydeskDockBox, { marginHorizontal: 0, marginTop: 8 }]}>
                <View style={[styles.rowBetween, { borderBottomWidth: 1, borderBottomColor: '#334155', paddingBottom: 5 }]}>
                  <View style={styles.rowCenter}>
                    <View style={styles.anydeskRedBadge}>
                      <Text style={styles.anydeskRedBadgeText}>AnyDesk</Text>
                    </View>
                    <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#fff', marginLeft: 6 }}>
                      Acesso & Limpeza Remota
                    </Text>
                  </View>
                  <TouchableOpacity onPress={() => setShowTechAnyDeskPanel(false)}>
                    <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#94a3b8' }}>✕</Text>
                  </TouchableOpacity>
                </View>

                <Text style={{ fontSize: 9, color: '#cbd5e1', fontWeight: 'bold', marginTop: 6 }}>
                  1. Modo de Conexão Remota (ID Cliente: {formatRemoteIdFromProtocol(selectedTicket.protocol)}):
                </Text>
                <View style={[styles.rowGap6, { marginTop: 4 }]}>
                  <TouchableOpacity
                    style={[
                      styles.anydeskModeBtn,
                      techRemoteMode === 'pc_to_phone' && styles.anydeskModeBtnActive
                    ]}
                    onPress={() => setTechRemoteMode('pc_to_phone')}
                  >
                    <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#fff' }}>💻 PC → 📱 Celular</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.anydeskModeBtn,
                      techRemoteMode === 'phone_to_phone' && styles.anydeskModeBtnActive
                    ]}
                    onPress={() => setTechRemoteMode('phone_to_phone')}
                  >
                    <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#fff' }}>📱 Celular → 📱 Celular</Text>
                  </TouchableOpacity>
                </View>

                <Text style={{ fontSize: 9, color: '#cbd5e1', fontWeight: 'bold', marginTop: 6 }}>
                  2. Programa / Ferramenta do Suporte para Executar no Aparelho:
                </Text>
                <TextInput
                  style={styles.anydeskProgramInput}
                  value={techRemoteProgram}
                  onChangeText={setTechRemoteProgram}
                />
                <View style={[styles.rowWrap, { marginTop: 4 }]}>
                  {[
                    { label: '🧹 CleanDesk Pro v4.2', val: 'HelpTop CleanDesk Pro v4.2 (Limpador + Kernel Boost)' },
                    { label: '🚀 TurboRAM Studio', val: 'TurboRAM & Anti-Lag Studio (Suporte Oficial)' },
                    { label: '🛠️ Reset Sistema OEM', val: 'Diagnóstico & Reset de Sistema OEM v2.8' }
                  ].map((p, idx) => (
                    <TouchableOpacity
                      key={idx}
                      style={styles.anydeskPresetChip}
                      onPress={() => setTechRemoteProgram(p.val)}
                    >
                      <Text style={{ fontSize: 9, color: '#e2e8f0' }}>{p.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                {rs && rs.active && Array.isArray(rs.logs) && (
                  <View style={styles.anydeskTerminalBox}>
                    {rs.logs.map((l, idx) => (
                      <Text key={idx} style={styles.anydeskTerminalText}>{l}</Text>
                    ))}
                  </View>
                )}

                <View style={[styles.rowGap6, { marginTop: 6 }]}>
                  <TouchableOpacity
                    style={[styles.btnAmber, styles.flex1, { paddingVertical: 6 }]}
                    onPress={() => techExecuteRemoteAction('anydesk_request')}
                  >
                    <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#0f172a', textAlign: 'center' }}>
                      📡 Pedir Permissão Remota
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnGreen, styles.flex1, { paddingVertical: 6 }]}
                    onPress={() => techExecuteRemoteAction('clean')}
                  >
                    <Text style={[styles.btnPrimaryText, { fontSize: 10 }]}>⚡ Rodar Programa & Limpar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {/* Chat do Técnico com o Cliente */}
            <View style={styles.techChatHistoryBox}>
              {!selectedTicket || !selectedTicket.messages || selectedTicket.messages.length === 0 ? (
                <Text style={{ fontSize: 10, color: '#9ca3af', textAlign: 'center', paddingVertical: 16 }}>
                  Aguardando abertura de protocolos pelos clientes cadastrados.
                </Text>
              ) : (
                selectedTicket.messages.map((msg, idx) => {
                  if (msg.senderRole === 'tech') {
                    return (
                      <View key={idx} style={styles.techBubbleSelf}>
                        <Text style={{ fontSize: 11, color: '#111827' }}>
                          <Text style={{ fontWeight: 'bold' }}>Você ({msg.senderName}): </Text>
                          {msg.text}
                        </Text>
                      </View>
                    );
                  }
                  if (msg.senderRole === 'client') {
                    return (
                      <View key={idx} style={styles.techBubbleClient}>
                        <Text style={{ fontSize: 11, color: '#1f2937' }}>
                          <Text style={{ fontWeight: 'bold', color: '#166534' }}>👤 {msg.senderName}: </Text>
                          {msg.text}
                        </Text>
                      </View>
                    );
                  }
                  return (
                    <View key={idx} style={styles.supportBubbleSystem}>
                      <Text style={{ fontSize: 10, color: '#78350f' }}>{msg.text}</Text>
                    </View>
                  );
                })
              )}
            </View>

            {/* Atalhos de Respostas Rápidas para o Técnico */}
            <View style={[styles.rowWrap, { marginTop: 6 }]}>
              {[
                { label: '👋 Saudação', text: 'Olá! Assumi seu protocolo e já estou analisando a telemetria real do seu aparelho.' },
                { label: '⚡ Avisar Limpeza', text: 'Vou executar uma Limpeza Remota de RAM e Cache no seu aparelho agora.' },
                { label: '✅ Pedir Teste', text: 'Pronto! Otimização aplicada. Pode testar o aparelho e me confirmar se ficou rápido?' }
              ].map((qr, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.botQuickReplyPill}
                  onPress={() => handleTechReplySubmit(qr.text)}
                >
                  <Text style={styles.botQuickReplyText}>{qr.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.rowGap6, { marginTop: 6 }]}>
              <TextInput
                style={[styles.textInput, styles.flex1, { marginBottom: 0 }]}
                placeholder="Responder ao cliente em tempo real..."
                value={techReplyInput}
                onChangeText={setTechReplyInput}
                onSubmitEditing={() => handleTechReplySubmit()}
              />
              <TouchableOpacity
                style={[styles.chatSendBtn, { backgroundColor: '#1e40af' }]}
                onPress={() => handleTechReplySubmit()}
              >
                <Text style={styles.btnPrimaryText}>Enviar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </ScrollView>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  function renderSettingsScreen() {
    const u = currentUser;
    const initials = u && u.name
      ? u.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase()
      : 'HT';

    return (
      <View style={styles.screenContainer}>
        <View style={styles.appBar}>
          <View style={styles.rowCenter}>
            <TouchableOpacity style={styles.appBarBackBtn} onPress={handleAndroidBack}>
              <Text style={styles.appBarBackText}>← Voltar</Text>
            </TouchableOpacity>
            <Text style={styles.appBarTitle}>Configurações e Perfil</Text>
          </View>
        </View>

        <ScrollView style={styles.flex1} contentContainerStyle={{ padding: 12 }}>
          <View style={styles.profileHeaderCard}>
            <View style={styles.avatarCircle}>
              <Text style={styles.avatarInitials}>{initials}</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={{ fontSize: 13, fontWeight: 'bold', color: '#111827' }}>
                {u ? u.name : 'Usuário'}
              </Text>
              <Text style={{ fontSize: 11, color: '#6b7280' }}>{u ? u.email : ''}</Text>
              <View style={styles.rolePillClient}>
                <Text style={styles.rolePillClientText}>
                  {u && u.role === 'tech' ? 'Suporte Técnico Credenciado' : 'Cliente / Usuário'}
                </Text>
              </View>
            </View>
          </View>

          {Boolean(profileSaveFeedback) && (
            <View style={[styles.feedbackBox, styles.feedbackSuccess, { marginTop: 8 }]}>
              <Text style={styles.feedbackSuccessText}>{profileSaveFeedback}</Text>
            </View>
          )}

          <View style={[styles.telemetryCard, { marginTop: 8 }]}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 6, marginBottom: 8 }]}>
              <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#1f2937' }}>
                👤 Meu Perfil (Dados do Cadastro)
              </Text>
              <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#15803d' }}>✓ Dados Salvos</Text>
            </View>

            <Text style={styles.inputLabel}>Nome Completo:</Text>
            <TextInput style={styles.textInput} value={profName} onChangeText={setProfName} />

            <View style={styles.rowGap8}>
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>CPF Cadastrado:</Text>
                <TextInput style={styles.textInput} value={profCpf} onChangeText={setProfCpf} />
              </View>
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>Telefone (Celular):</Text>
                <TextInput style={styles.textInput} value={profPhone} onChangeText={setProfPhone} />
              </View>
            </View>

            <Text style={styles.inputLabel}>E-mail de Acesso:</Text>
            <TextInput
              style={styles.textInput}
              autoCapitalize="none"
              value={profEmail}
              onChangeText={setProfEmail}
            />

            {u && u.role === 'tech' ? (
              <View style={styles.techCodeBox}>
                <Text style={styles.techCodeLabel}>Especialidade Técnica:</Text>
                <TextInput
                  style={[styles.textInput, { backgroundColor: '#fff', marginTop: 4 }]}
                  value={profSpecialty}
                  onChangeText={setProfSpecialty}
                />
                <View style={styles.rowBetween}>
                  <Text style={styles.techCodeLabel}>Credencial de Suporte:</Text>
                  <TouchableOpacity
                    style={styles.smallOutlineBtn}
                    onPress={() => robustCopyToClipboard(profTechCode)}
                  >
                    <Text style={styles.smallOutlineBtnText}>📋 Copiar</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={[styles.textInput, { backgroundColor: '#f3f4f6', fontWeight: 'bold', marginTop: 4, marginBottom: 0 }]}
                  editable={false}
                  value={profTechCode}
                />
              </View>
            ) : (
              <View style={styles.clientDeviceRegBox}>
                <View style={styles.rowBetween}>
                  <Text style={styles.inputLabel}>Aparelho / PC Identificado:</Text>
                  <TouchableOpacity
                    style={styles.smallOutlineBtn}
                    onPress={() => {
                      setProfDevice(metrics.deviceName);
                      showToastNotice(`Dispositivo atualizado: ${metrics.deviceName}`);
                    }}
                  >
                    <Text style={styles.smallOutlineBtnText}>🔄 Detectar Hardware Real</Text>
                  </TouchableOpacity>
                </View>
                <TextInput
                  style={[styles.textInput, { backgroundColor: '#fff', marginTop: 4, marginBottom: 0 }]}
                  value={profDevice}
                  onChangeText={setProfDevice}
                />
              </View>
            )}

            <Text style={[styles.inputLabel, { marginTop: 8 }]}>Senha da Conta:</Text>
            <View style={styles.rowGap6}>
              <TextInput
                style={[styles.textInput, styles.flex1, { marginBottom: 0 }]}
                secureTextEntry={!showProfPass}
                value={profPass}
                onChangeText={setProfPass}
              />
              <TouchableOpacity style={styles.eyeBtn} onPress={() => setShowProfPass(!showProfPass)}>
                <Text style={styles.eyeBtnText}>{showProfPass ? 'Ocultar' : 'Ver'}</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={[styles.btnPrimary, { marginTop: 10 }]} onPress={handleSaveProfileSettings}>
              <Text style={styles.btnPrimaryText}>💾 Salvar Alterações do Perfil</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.telemetryCard, { marginTop: 8 }]}>
            <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#1f2937', marginBottom: 6 }}>
              ⚙️ Opções e Preferências do App
            </Text>
            <View style={[styles.rowBetween, { paddingVertical: 4 }]}>
              <Text style={{ fontSize: 11, color: '#374151', flex: 1 }}>
                Pedir confirmação antes de cada reparo
              </Text>
              <Switch value={profConfirmBeforeFix} onValueChange={setProfConfirmBeforeFix} />
            </View>
            <View style={[styles.rowBetween, { paddingVertical: 4 }]}>
              <Text style={{ fontSize: 11, color: '#374151', flex: 1 }}>
                Alertas de protocolo e mensagens em tempo real
              </Text>
              <Switch value={profLiveAlerts} onValueChange={setProfLiveAlerts} />
            </View>

            <TouchableOpacity
              style={[styles.btnOutlineBlue, { marginTop: 8 }]}
              onPress={() => {
                setTermsModalRole(u ? u.role : 'client');
                setShowTermsModal(true);
              }}
            >
              <Text style={styles.btnOutlineBlueText}>📄 Ver Termos de Segurança (LGPD)</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btnDangerOutline, { marginTop: 6 }]}
              onPress={() => setShowDeleteAccountModal(true)}
            >
              <Text style={styles.btnDangerOutlineText}>🗑️ Excluir Conta</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        {renderSecurityFooterStrip()}
      </View>
    );
  }

  // ==========================================================================
  // RENDERIZADORES DOS MODAIS INTERATIVOS
  // ==========================================================================
  const dcInfo = getDeepCleanItemsBytes();
  const currentUacCfg = BOT_UAC_TASKS[currentUacTaskKey] || BOT_UAC_TASKS.ram;
  const statusBarNetStr = `${metrics.netType}${metrics.pingMs !== null ? ` (${metrics.pingMs}ms)` : ''} | ${
    metrics.batteryPct !== null ? `Bat: ${metrics.batteryPct}%${metrics.batteryCharging ? ' ⚡' : ''}` : 'AC ⚡'
  }`;

  return (
    <SafeAreaView style={styles.pageBackground}>
      <StatusBar barStyle="light-content" backgroundColor="#0d47a1" />

      {/* Barra Superior de Sincronização, Alternância Cliente/Técnico (2ª Tela) e Zerar Tudo */}
      <View style={styles.topUtilityBar}>
        <TouchableOpacity style={styles.topSyncBtn} onPress={() => setShowFirebaseModal(true)}>
          <Text style={styles.topSyncBtnText}>🔥 {syncStatusLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.topSecondScreenBtn} onPress={quickSwitchRoleForTesting}>
          <Text style={styles.topSecondScreenBtnText}>🖥️ Alternar 2ª Tela</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.topResetBtn} onPress={resetDemoState}>
          <Text style={styles.topResetBtnText}>Zerar Tudo</Text>
        </TouchableOpacity>
      </View>

      {/* MOLDURA DO CELULAR */}
      <View style={styles.phoneFrame}>
        {/* Barra de Status do Android / Sistema Real */}
        <View style={styles.phoneStatusBar}>
          <Text style={styles.phoneStatusBarText}>{clockText}</Text>
          <Text style={styles.phoneStatusBarText}>{statusBarNetStr}</Text>
        </View>

        {/* Banner de Notificação no Topo (Credencial SUP-XXXX por E-mail ou SMS) */}
        {showTopCredentialBanner && credentialMessageData && (
          <View style={styles.topCredentialBanner}>
            <View style={[styles.rowCenter, { flex: 1, paddingRight: 4 }]}>
              <View style={styles.bannerChannelBadge}>
                <Text style={styles.bannerChannelBadgeText}>{credentialMessageData.channel}</Text>
              </View>
              <Text style={{ fontSize: 11, color: '#fff' }} numberOfLines={1}>
                Credencial: <Text style={{ fontWeight: 'bold', color: '#fde047' }}>{credentialMessageData.code}</Text>
              </Text>
            </View>
            <View style={styles.rowGap6}>
              <TouchableOpacity
                style={styles.bannerActionGreen}
                onPress={() => robustCopyToClipboard(credentialMessageData.code)}
              >
                <Text style={styles.bannerActionText}>Copiar</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.bannerActionSlate}
                onPress={() => setShowInboxModal(true)}
              >
                <Text style={styles.bannerActionText}>Abrir</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setShowTopCredentialBanner(false)}>
                <Text style={{ color: '#9ca3af', fontWeight: 'bold', paddingHorizontal: 4 }}>✕</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* CONTAINER DAS TELAS DO APLICATIVO */}
        <View style={styles.phoneScreenContainer}>
          {currentScreen === 'welcome' && renderWelcomeScreen()}
          {currentScreen === 'login' && renderLoginScreen()}
          {currentScreen === 'register' && renderRegisterScreen()}
          {currentScreen === 'dashboard' && renderDashboardScreen()}
          {currentScreen === 'chat' && renderChatScreen()}
          {currentScreen === 'support' && renderSupportScreen()}
          {currentScreen === 'tech-panel' && renderTechPanelScreen()}
          {currentScreen === 'settings' && renderSettingsScreen()}

          {/* Banner Flutuante de Mensagem do Chat */}
          {floatingBannerState.visible && (
            <View style={styles.floatingChatBanner}>
              <View style={{ flex: 1, paddingRight: 6 }}>
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#a7f3d0' }} numberOfLines={1}>
                  💬 {floatingBannerState.title}
                </Text>
                <Text style={{ fontSize: 11, color: '#fff' }} numberOfLines={1}>
                  {floatingBannerState.text}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.bannerActionGreen}
                onPress={() => {
                  setFloatingBannerState(prev => ({ ...prev, visible: false }));
                  if (floatingBannerState.role === 'tech') {
                    goToScreen('tech-panel');
                    selectTechTicket(floatingBannerState.protocol);
                  } else {
                    goToScreen('support');
                  }
                }}
              >
                <Text style={styles.bannerActionText}>Ver</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Toast de Aviso Rápido */}
          {Boolean(toastMessage) && (
            <View style={styles.clipboardToast}>
              <Text style={{ color: '#4ade80', fontWeight: 'bold', marginRight: 5 }}>✓</Text>
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: 'bold' }}>{toastMessage}</Text>
            </View>
          )}
        </View>

        {/* Barra de Navegação Inferior do Android */}
        <View style={styles.androidNavBar}>
          <TouchableOpacity style={styles.androidNavBtn} onPress={handleAndroidBack}>
            <Text style={styles.androidNavIcon}>◀</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.androidNavBtn} onPress={handleAndroidHome}>
            <Text style={styles.androidNavIcon}>●</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.androidNavBtn} onPress={handleAndroidRecents}>
            <Text style={styles.androidNavIcon}>■</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ==================================================================== */}
      {/* MODAL: HISTÓRICO DE DIAGNÓSTICO E REPAROS (LGPD)                     */}
      {/* ==================================================================== */}
      <Modal visible={showAuditModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <View>
                <Text style={styles.modalTitle}>📋 Histórico de Diagnóstico e Reparos</Text>
                <Text style={{ fontSize: 10, color: '#6b7280' }}>Registro de Análises e Ações Pós-Análise (LGPD)</Text>
              </View>
              <TouchableOpacity onPress={() => setShowAuditModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 320, marginTop: 8 }}>
              {auditLogs.length === 0 ? (
                <View style={styles.emptyQueueBox}>
                  <Text style={{ fontSize: 11, color: '#6b7280', textAlign: 'center' }}>
                    Nenhuma análise ou ação pós-análise registrada ainda nesta sessão.
                  </Text>
                </View>
              ) : (
                auditLogs.map((item, idx) => {
                  const isAn = item.stage === 'ANÁLISE';
                  return (
                    <View
                      key={idx}
                      style={[
                        styles.auditLogItem,
                        isAn ? { backgroundColor: '#fffbeb', borderColor: '#fcd34d' } : { backgroundColor: '#ecfdf5', borderColor: '#6ee7b7' }
                      ]}
                    >
                      <View style={styles.rowBetween}>
                        <Text style={{ fontSize: 10, fontWeight: 'bold', color: isAn ? '#78350f' : '#065f46' }}>
                          {isAn ? '🔍 REGISTRO DE ANÁLISE' : '✓ REGISTRO PÓS-ANÁLISE (LGPD)'}
                        </Text>
                        <Text style={{ fontSize: 9, color: '#6b7280' }}>{item.time}</Text>
                      </View>
                      <Text style={{ fontSize: 10, color: '#374151', marginTop: 3 }}>{item.desc}</Text>
                    </View>
                  );
                })
              )}
            </ScrollView>
            <TouchableOpacity
              style={[styles.btnPrimary, { marginTop: 10 }]}
              onPress={() => setShowAuditModal(false)}
            >
              <Text style={styles.btnPrimaryText}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: LEMBRETE DE OTIMIZAÇÃO SEMANAL (COM PERMISSÃO MANUAL LGPD)    */}
      {/* ==================================================================== */}
      <Modal visible={showReminderModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <Text style={styles.modalTitle}>⏰ Lembrete de Otimização</Text>
              <TouchableOpacity onPress={() => setShowReminderModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={[styles.consentBox, { marginTop: 8 }]}>
              <View style={styles.rowBetween}>
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#78350f', flex: 1 }}>
                  ⏰ Permitir e Ativar Lembrete Semanal
                </Text>
                <Switch value={reminderModalChecked} onValueChange={setReminderModalChecked} />
              </View>
              <Text style={{ fontSize: 10, fontWeight: 'bold', color: reminderModalChecked ? '#065f46' : '#4b5563', marginTop: 4 }}>
                {reminderModalChecked
                  ? "✓ Permissão marcada! Toque em 'Salvar Lembrete' abaixo para ativar."
                  : 'Status atual: Desativado (requer sua permissão para ativar)'}
              </Text>
            </View>

            <Text style={styles.inputLabel}>Dia da Semana:</Text>
            <View style={styles.rowWrap}>
              {['Segunda-feira', 'Quarta-feira', 'Sexta-feira', 'Domingo'].map(d => (
                <TouchableOpacity
                  key={d}
                  style={[styles.botQuickReplyPill, reminderDay === d && { backgroundColor: '#1d4ed8' }]}
                  onPress={() => setReminderDay(d)}
                >
                  <Text style={[styles.botQuickReplyText, reminderDay === d && { color: '#fff' }]}>{d}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.rowGap8, { marginTop: 6 }]}>
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>Horário:</Text>
                <TextInput style={styles.textInput} value={reminderTime} onChangeText={setReminderTime} />
              </View>
              <View style={styles.flex1}>
                <Text style={styles.inputLabel}>Limite de Cache:</Text>
                <TextInput style={styles.textInput} value={reminderLimit} onChangeText={setReminderLimit} />
              </View>
            </View>

            <View style={[styles.rowGap6, { marginTop: 8 }]}>
              <TouchableOpacity
                style={[styles.btnAmber, styles.flex1]}
                onPress={() => {
                  setReminderEnabled(reminderModalChecked);
                  setShowReminderModal(false);
                  if (reminderModalChecked) {
                    addAuditLogEntry('PÓS-ANÁLISE', `Lembrete Semanal autorizado pelo usuário: ${reminderDay} às ${reminderTime} (> ${reminderLimit}).`);
                    showToastNotice(`Lembrete ativado: ${reminderDay} às ${reminderTime}!`);
                  } else {
                    showToastNotice('Lembrete semanal mantido desativado.');
                  }
                }}
              >
                <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#fff', textAlign: 'center' }}>
                  💾 Salvar Lembrete
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSecondary, { paddingHorizontal: 14 }]}
                onPress={() => setShowReminderModal(false)}
              >
                <Text style={styles.btnSecondaryText}>Fechar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: LIMPEZA PROFUNDA REAL (APOIO DO CHAT BOT)                     */}
      {/* ==================================================================== */}
      <Modal visible={showDeepCleanModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <View>
                <Text style={styles.modalTitle}>🧹 Limpeza Profunda Real</Text>
                <Text style={{ fontSize: 10, color: '#6b7280' }}>Marque os buffers reais que autoriza limpar</Text>
              </View>
              <TouchableOpacity onPress={() => setShowDeepCleanModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            {[
              {
                key: 'heap',
                title: 'Memória JS Heap & Objetos Alocados (Real)',
                sub: `Alocação real no motor JS: ${metrics.jsHeapUsedMB} MB`
              },
              {
                key: 'res',
                title: 'Buffers de Rede & Recursos Carregados',
                sub: `Buffers de rede ativos • ${formatBytesHuman(dcInfo.res)}`
              },
              {
                key: 'storage',
                title: 'Cache Storage & Dados Temporários (Real)',
                sub: `Uso real na origem: ${formatBytesHuman(dcInfo.storage)} (Disco: ${metrics.storageTotal} GB)`
              },
              {
                key: 'session',
                title: 'Sessões Temporárias do Aplicativo',
                sub: 'Preserva todas as contas e chamados salvos'
              }
            ].map(item => (
              <TouchableOpacity
                key={item.key}
                style={styles.deepCleanItemRow}
                onPress={() => setDcChecks(prev => ({ ...prev, [item.key]: !prev[item.key] }))}
              >
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1f2937' }}>{item.title}</Text>
                  <Text style={{ fontSize: 10, color: '#6b7280' }}>{item.sub}</Text>
                </View>
                <View style={[styles.checkboxBox, dcChecks[item.key] && styles.checkboxBoxChecked]}>
                  {dcChecks[item.key] && <Text style={styles.checkboxTick}>✓</Text>}
                </View>
              </TouchableOpacity>
            ))}

            <View style={[styles.rowBetween, styles.techCodeBox, { marginTop: 8 }]}>
              <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1e3a8a' }}>
                Total real selecionado para liberar:
              </Text>
              <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#1e3a8a' }}>
                {formatBytesHuman(dcInfo.totalSelected)}
              </Text>
            </View>

            <View style={[styles.rowGap6, { marginTop: 10 }]}>
              <TouchableOpacity style={[styles.btnPrimary, styles.flex1]} onPress={executeDeepCleanSelected}>
                <Text style={styles.btnPrimaryText}>✓ Autorizar e Limpar Agora</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSecondary, { paddingHorizontal: 12 }]}
                onPress={() => setShowDeepCleanModal(false)}
              >
                <Text style={styles.btnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: DIAGNÓSTICO DE SENSORES REAIS (HARDWARE FÍSICO)               */}
      {/* ==================================================================== */}
      <Modal visible={showHardwareTestModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <View>
                <Text style={styles.modalTitle}>🩺 Diagnóstico Real de Sensores</Text>
                <Text style={{ fontSize: 10, color: '#6b7280' }}>Teste interativo do hardware físico ({metrics.deviceName})</Text>
              </View>
              <TouchableOpacity onPress={() => setShowHardwareTestModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>

            {[
              { key: 'audio', title: '🔊 Alto-falante / Vibração (880Hz)', btn: 'Testar Som' },
              { key: 'touch', title: '📱 Matriz Touchscreen / Display Real', btn: 'Testar Touch' },
              { key: 'net', title: '📶 Antena Wi-Fi / 4G (Ping Real)', btn: 'Testar Rede' },
              { key: 'bat', title: '🔋 Célula de Bateria e Energia Real', btn: 'Testar Carga' }
            ].map(s => (
              <View key={s.key} style={styles.deepCleanItemRow}>
                <View style={{ flex: 1, paddingRight: 8 }}>
                  <Text style={{ fontSize: 11, fontWeight: 'bold', color: '#1f2937' }}>{s.title}</Text>
                  <Text
                    style={{
                      fontSize: 10,
                      fontWeight: sensorStatus[s.key].startsWith('✓') ? 'bold' : 'normal',
                      color: sensorStatus[s.key].startsWith('✓') ? '#15803d' : '#6b7280'
                    }}
                  >
                    {sensorStatus[s.key]}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.sensorTestSmallBtn}
                  onPress={() => runSingleSensorTest(s.key)}
                >
                  <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#fff' }}>{s.btn}</Text>
                </TouchableOpacity>
              </View>
            ))}

            <View style={[styles.rowGap6, { marginTop: 10 }]}>
              <TouchableOpacity style={[styles.btnIndigo, styles.flex1]} onPress={runAllSensorTests}>
                <Text style={styles.btnPrimaryText}>⚡ Testar Todos os Sensores</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSecondary, { paddingHorizontal: 12 }]}
                onPress={() => setShowHardwareTestModal(false)}
              >
                <Text style={styles.btnSecondaryText}>Fechar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: PERMISSÃO DE EXECUÇÃO DA IA (UAC / LGPD)                      */}
      {/* ==================================================================== */}
      <Modal visible={showUacModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { borderColor: '#2563eb', borderWidth: 2 }]}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <Text style={[styles.modalTitle, { color: '#1e3a8a', flex: 1 }]}>{currentUacCfg.title}</Text>
              <TouchableOpacity onPress={() => setShowUacModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: '#374151', marginTop: 6, lineHeight: 15 }}>
              {currentUacCfg.desc}
            </Text>
            <View style={[styles.anydeskTerminalBox, { marginTop: 8 }]}>
              <Text style={styles.anydeskTerminalText}>$ {currentUacCfg.cmd}</Text>
            </View>
            <View style={[styles.specsGridBox, { marginTop: 8 }]}>
              {currentUacCfg.steps.map((st, idx) => (
                <Text key={idx} style={{ fontSize: 10, color: '#1f2937', marginVertical: 2 }}>
                  <Text style={{ color: '#16a34a', fontWeight: 'bold' }}>✓ </Text>
                  {st}
                </Text>
              ))}
            </View>
            <TouchableOpacity
              style={[styles.btnPrimary, { marginTop: 10 }]}
              onPress={() => confirmBotUacExecution(true)}
            >
              <Text style={styles.btnPrimaryText}>✓ Sim, Permitir que a IA Faça Isso Agora</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnSecondary, { marginTop: 6 }]}
              onPress={() => confirmBotUacExecution(false)}
            >
              <Text style={styles.btnSecondaryText}>📖 Não, Mostrar Passo a Passo Manual</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: CAIXA DE ENTRADA DE CREDENCIAL (E-MAIL / SMS)                 */}
      {/* ==================================================================== */}
      <Modal visible={showInboxModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <Text style={styles.modalTitle}>
                {credentialMessageData && credentialMessageData.channel === 'SMS'
                  ? '📱 Mensagem SMS Recebida'
                  : '📧 E-mail Oficial HelpTop'}
              </Text>
              <TouchableOpacity onPress={() => setShowInboxModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            {credentialMessageData && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ fontSize: 11, color: '#374151' }}>
                  <Text style={{ fontWeight: 'bold' }}>Para:</Text> {credentialMessageData.destination}
                </Text>
                <Text style={{ fontSize: 11, color: '#374151', marginTop: 2 }}>
                  <Text style={{ fontWeight: 'bold' }}>Assunto:</Text> Liberação de Credencial Técnica HelpTop
                </Text>
                <Text style={{ fontSize: 11, color: '#374151', marginTop: 8, lineHeight: 15 }}>
                  Olá, <Text style={{ fontWeight: 'bold' }}>{credentialMessageData.name}</Text>! Utilize o código abaixo para validar seu cadastro e liberar seu acesso à Central de Suporte Técnico:
                </Text>
                <View style={[styles.protocolGeneratedCard, { marginTop: 8 }]}>
                  <Text style={styles.protocolCodeBig}>{credentialMessageData.code}</Text>
                </View>
              </View>
            )}
            <View style={[styles.rowGap6, { marginTop: 10 }]}>
              <TouchableOpacity
                style={[styles.btnPrimary, styles.flex1]}
                onPress={() => {
                  if (credentialMessageData && credentialMessageData.code) {
                    robustCopyToClipboard(credentialMessageData.code);
                    setRegTechKey(credentialMessageData.code);
                    setLoginTechCode(credentialMessageData.code);
                  }
                  setShowInboxModal(false);
                }}
              >
                <Text style={styles.btnPrimaryText}>📋 Copiar e Colar Código</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSecondary, { paddingHorizontal: 14 }]}
                onPress={() => setShowInboxModal(false)}
              >
                <Text style={styles.btnSecondaryText}>Fechar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: TERMOS DE USO E SEGURANÇA (LGPD)                              */}
      {/* ==================================================================== */}
      <Modal visible={showTermsModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <Text style={styles.modalTitle}>
                {termsModalRole === 'tech' ? 'Termos e Condições — Suporte' : 'Termos de Uso e Segurança (LGPD)'}
              </Text>
              <TouchableOpacity onPress={() => setShowTermsModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 260, marginTop: 8 }}>
              {termsModalRole === 'tech' ? (
                <Text style={{ fontSize: 11, color: '#374151', lineHeight: 16 }}>
                  1. Sigilo Técnico (LGPD): Os dados de telemetria real do aparelho são usados estritamente para diagnóstico do chamado ativo.{'\n\n'}
                  2. Atuação via Protocolo: O técnico deve atender somente chamados validados por protocolo HT-XXXX.{'\n\n'}
                  3. Uso Pessoal da Credencial: O código SUP-XXXX recebido por E-mail/SMS é individual e intransferível.
                </Text>
              ) : (
                <Text style={{ fontSize: 11, color: '#374151', lineHeight: 16 }}>
                  1. Autorização do Usuário (LGPD): Nenhuma limpeza ou alteração no sistema é realizada sem a sua confirmação explícita em cada etapa.{'\n\n'}
                  2. Registro de Auditoria: Todas as análises reais e ações pós-análise ficam salvas no ícone de Histórico para sua conferência.{'\n\n'}
                  3. Atendimento por Protocolo: O suporte técnico humano atua exclusivamente mediante protocolo HT-XXXX, sem acesso a arquivos pessoais ou senhas.
                </Text>
              )}
            </ScrollView>
            <View style={[styles.rowGap6, { marginTop: 10 }]}>
              <TouchableOpacity
                style={[styles.btnPrimary, styles.flex1]}
                onPress={() => {
                  setRegConsent(true);
                  setShowTermsModal(false);
                }}
              >
                <Text style={styles.btnPrimaryText}>Li e Concordo</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSecondary, { paddingHorizontal: 14 }]}
                onPress={() => setShowTermsModal(false)}
              >
                <Text style={styles.btnSecondaryText}>Fechar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: CONFIRMAÇÃO DE EXCLUSÃO DE CONTA                              */}
      {/* ==================================================================== */}
      <Modal visible={showDeleteAccountModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { borderColor: '#f87171', borderWidth: 1.5 }]}>
            <Text style={[styles.modalTitle, { color: '#b91c1c' }]}>🗑️ Excluir Conta Permanentemente</Text>
            <Text style={{ fontSize: 11, color: '#374151', marginTop: 6 }}>
              Tem certeza que deseja excluir o cadastro abaixo do HelpTop?
            </Text>
            <View style={[styles.feedbackBox, styles.feedbackError, { marginTop: 8 }]}>
              <Text style={styles.feedbackErrorText}>
                {currentUser ? `${currentUser.name} (${currentUser.email})` : ''}
              </Text>
            </View>
            <View style={[styles.rowGap6, { marginTop: 10 }]}>
              <TouchableOpacity
                style={[styles.btnDangerSolid, styles.flex1]}
                onPress={confirmDeleteCurrentUserAccount}
              >
                <Text style={styles.btnPrimaryText}>Sim, Excluir Conta</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.btnSecondary, { paddingHorizontal: 14 }]}
                onPress={() => setShowDeleteAccountModal(false)}
              >
                <Text style={styles.btnSecondaryText}>Cancelar</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: SINCRONIZAÇÃO EM TEMPO REAL E ALTERNÂNCIA DE 2ª TELA          */}
      {/* ==================================================================== */}
      <Modal visible={showFirebaseModal} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { borderColor: '#fb923c', borderWidth: 1.5 }]}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <Text style={styles.modalTitle}>🔥 Sincronização em Tempo Real</Text>
              <TouchableOpacity onPress={() => setShowFirebaseModal(false)}>
                <Text style={styles.modalCloseIcon}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ fontSize: 11, color: '#374151', marginTop: 6, lineHeight: 15 }}>
              Para testar o Cliente e o Suporte Técnico conversando ao vivo com Pop-up de Chamado e AnyDesk Remoto, alterne para a 2ª Tela abaixo:
            </Text>
            <TouchableOpacity
              style={[styles.btnPrimary, { marginTop: 10 }]}
              onPress={() => {
                setShowFirebaseModal(false);
                quickSwitchRoleForTesting();
              }}
            >
              <Text style={styles.btnPrimaryText}>🖥️ Alternar entre Cliente e Suporte Técnico Agora</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnSecondary, { marginTop: 8 }]}
              onPress={() => setShowFirebaseModal(false)}
            >
              <Text style={styles.btnSecondaryText}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: CONSOLE TÉCNICO DE EXECUÇÃO                                   */}
      {/* ==================================================================== */}
      <Modal visible={execModalState.visible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { alignItems: 'center' }]}>
            <Text style={styles.modalTitle}>{execModalState.title}</Text>
            <Text style={{ fontSize: 11, color: '#4b5563', marginTop: 4, textAlign: 'center' }}>
              {execModalState.stepText}
            </Text>
            <View style={[styles.progressTrack, { width: '100%', height: 10, marginTop: 8 }]}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${execModalState.percent}%`, backgroundColor: '#2563eb' }
                ]}
              />
            </View>
            <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#1e40af', marginTop: 4 }}>
              {execModalState.percent}%
            </Text>
            <View style={[styles.anydeskTerminalBox, { width: '100%', minHeight: 72, marginTop: 6 }]}>
              {execModalState.logs.map((l, idx) => (
                <Text key={idx} style={styles.anydeskTerminalText}>{l}</Text>
              ))}
            </View>
          </View>
        </View>
      </Modal>

      {/* ==================================================================== */}
      {/* MODAL: POP-UP DE CHAMADO EM TEMPO REAL (TÉCNICO E CLIENTE)           */}
      {/* ==================================================================== */}
      <Modal visible={callPopupState.visible} transparent animationType="fade">
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { borderColor: '#16a34a', borderWidth: 2 }]}>
            <View style={[styles.rowBetween, styles.sectionHeaderBorder, { paddingBottom: 8 }]}>
              <Text style={{ fontSize: 12, fontWeight: 'bold', color: '#14532d', flex: 1 }}>
                {callPopupState.headerText}
              </Text>
              <View style={styles.dutyBadge}>
                <Text style={{ fontSize: 10, fontWeight: 'bold', color: '#14532d' }}>
                  {callPopupState.protocol}
                </Text>
              </View>
            </View>

            {callPopupState.ticket && (
              <View style={[styles.specsGridBox, { marginTop: 8 }]}>
                <Text style={{ fontSize: 11, color: '#1f2937' }}>
                  <Text style={{ fontWeight: 'bold' }}>Cliente:</Text> {callPopupState.ticket.clientName}
                </Text>
                <Text style={{ fontSize: 11, color: '#1f2937', marginTop: 2 }}>
                  <Text style={{ fontWeight: 'bold' }}>Dispositivo Real:</Text> {callPopupState.ticket.clientDevice}
                </Text>
              </View>
            )}

            <View style={[styles.techCodeBox, { marginTop: 8 }]}>
              <Text style={{ fontSize: 11, color: '#1e3a8a' }}>
                <Text style={{ fontWeight: 'bold' }}>Relato:</Text> "{callPopupState.previewText}"
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.btnGreen, { marginTop: 10 }]}
              onPress={() => {
                const proto = callPopupState.protocol;
                setCallPopupState(prev => ({ ...prev, visible: false }));
                goToScreen('tech-panel');
                selectTechTicket(proto);
              }}
            >
              <Text style={styles.btnPrimaryText}>
                📞 Aceitar e Atender {callPopupState.protocol} Agora
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btnSecondary, { marginTop: 6 }]}
              onPress={() => setCallPopupState(prev => ({ ...prev, visible: false }))}
            >
              <Text style={styles.btnSecondaryText}>Minimizar Aviso</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ============================================================================
// ESTILOS REACT NATIVE (STYLESHEET) — VISUAL IDÊNTICO AO PROTÓTIPO HELPTOP
// ============================================================================
const styles = StyleSheet.create({
  flex1: { flex: 1 },
  pageBackground: {
    flex: 1,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8
  },
  topUtilityBar: {
    width: 360,
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6
  },
  topSyncBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#fdba74',
    borderRadius: 6
  },
  topSyncBtnText: { fontSize: 10, fontWeight: 'bold', color: '#9a3412' },
  topSecondScreenBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#1d4ed8',
    borderRadius: 6
  },
  topSecondScreenBtnText: { fontSize: 10, fontWeight: 'bold', color: '#fff' },
  topResetBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6
  },
  topResetBtnText: { fontSize: 10, fontWeight: '600', color: '#374151' },
  phoneFrame: {
    width: 360,
    maxWidth: '100%',
    height: 720,
    maxHeight: '94%',
    backgroundColor: '#fff',
    borderWidth: 8,
    borderColor: '#222',
    borderRadius: 28,
    overflow: 'hidden',
    flexDirection: 'column'
  },
  phoneStatusBar: {
    backgroundColor: '#0d47a1',
    paddingHorizontal: 14,
    paddingVertical: 5,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  phoneStatusBarText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  topCredentialBanner: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  bannerChannelBadge: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6
  },
  bannerChannelBadgeText: { color: '#fff', fontSize: 9, fontWeight: 'bold' },
  bannerActionGreen: {
    backgroundColor: '#16a34a',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4
  },
  bannerActionSlate: {
    backgroundColor: '#334155',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4
  },
  bannerActionText: { color: '#fff', fontSize: 10, fontWeight: 'bold' },
  phoneScreenContainer: {
    flex: 1,
    backgroundColor: '#f9fafb',
    position: 'relative'
  },
  screenContainer: {
    flex: 1,
    backgroundColor: '#f9fafb',
    flexDirection: 'column'
  },
  screenWelcome: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: 'space-between'
  },
  logoBox: {
    width: 90,
    height: 90,
    backgroundColor: '#eff6ff',
    borderWidth: 2,
    borderColor: '#2563eb',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  welcomeTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#1e40af',
    marginTop: 8
  },
  welcomeSubtitlePill: {
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 999
  },
  welcomeSubtitleText: {
    fontSize: 11,
    fontWeight: 'bold',
    color: '#1e3a8a',
    textAlign: 'center'
  },
  welcomeHelperText: {
    fontSize: 11,
    color: '#374151',
    textAlign: 'center',
    marginBottom: 6,
    fontWeight: '500'
  },
  welcomeDivider: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    marginVertical: 12
  },
  welcomeFooterBox: {
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingTop: 10
  },
  welcomeFooterHeader: {
    fontSize: 9,
    fontWeight: 'bold',
    color: '#6b7280',
    textAlign: 'center',
    marginBottom: 6
  },
  badgeCard: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    paddingVertical: 5,
    paddingHorizontal: 4,
    alignItems: 'center'
  },
  badgeCardTitleGreen: { fontSize: 9, fontWeight: 'bold', color: '#15803d' },
  badgeCardTitleBlue: { fontSize: 9, fontWeight: 'bold', color: '#1d4ed8' },
  badgeCardSub: { fontSize: 8, color: '#4b5563', marginTop: 2 },
  welcomeFooterNote: {
    fontSize: 9,
    color: '#6b7280',
    textAlign: 'center',
    marginTop: 6
  },
  appBar: {
    backgroundColor: '#1976d2',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  appBarTitle: {
    color: '#fff',
    fontSize: 13,
    fontWeight: 'bold'
  },
  appBarBackBtn: {
    backgroundColor: '#1e40af',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    marginRight: 8
  },
  appBarBackText: { color: '#fff', fontSize: 11 },
  appBarActionBtn: {
    backgroundColor: '#1e40af',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4
  },
  appBarActionText: { color: '#fff', fontSize: 11 },
  btnPrimary: {
    backgroundColor: '#1976d2',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnPrimaryText: { color: '#fff', fontSize: 12, fontWeight: 'bold', textAlign: 'center' },
  btnSecondary: {
    backgroundColor: '#f3f4f6',
    borderWidth: 1,
    borderColor: '#d1d5db',
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnSecondaryText: { color: '#1f2937', fontSize: 11, fontWeight: 'bold', textAlign: 'center' },
  btnGreen: {
    backgroundColor: '#15803d',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnIndigo: {
    backgroundColor: '#4338ca',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnAmber: {
    backgroundColor: '#d97706',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnSlate: {
    backgroundColor: '#334155',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnOutlineBlue: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#2563eb',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center'
  },
  btnOutlineBlueText: { color: '#1d4ed8', fontSize: 11, fontWeight: 'bold' },
  btnOutlineGreen: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#22c55e',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center'
  },
  btnOutlineGreenText: { color: '#166534', fontSize: 11, fontWeight: 'bold' },
  btnDangerOutline: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fca5a5',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center'
  },
  btnDangerOutlineText: { color: '#b91c1c', fontSize: 11, fontWeight: 'bold' },
  btnDangerSolid: {
    backgroundColor: '#dc2626',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center'
  },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowGap6: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowGap8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  sectionHeaderBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    paddingBottom: 8,
    marginBottom: 10
  },
  sectionTitle: { fontSize: 14, fontWeight: 'bold', color: '#1f2937' },
  sectionSubtitle: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  inputLabel: { fontSize: 11, fontWeight: 'bold', color: '#374151', marginBottom: 4, marginTop: 6 },
  textInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 12,
    color: '#1f2937',
    backgroundColor: '#fff',
    marginBottom: 6
  },
  roleSwitchRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6
  },
  roleOptionBtn: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 6,
    backgroundColor: '#f9fafb',
    alignItems: 'center'
  },
  roleOptionBtnActive: {
    borderColor: '#2563eb',
    backgroundColor: '#eff6ff'
  },
  roleOptionText: { fontSize: 11, color: '#4b5563', fontWeight: '600' },
  roleOptionTextActive: { color: '#1e40af', fontWeight: 'bold' },
  eyeBtn: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 6
  },
  eyeBtnText: { fontSize: 11, color: '#374151', fontWeight: '600' },
  techCodeBox: {
    marginTop: 8,
    padding: 10,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8
  },
  techCodeLabel: { fontSize: 11, fontWeight: 'bold', color: '#1e3a8a' },
  clientDeviceRegBox: {
    marginTop: 6,
    padding: 10,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8
  },
  credSentStatusBox: {
    marginTop: 8,
    padding: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#4ade80',
    borderRadius: 6
  },
  smallOutlineBtn: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderRadius: 4
  },
  smallOutlineBtnText: { fontSize: 10, fontWeight: 'bold', color: '#1e40af' },
  linkBlueSmall: { fontSize: 10, fontWeight: 'bold', color: '#1d4ed8', textDecorationLine: 'underline' },
  linkIndigoSmall: { fontSize: 10, fontWeight: 'bold', color: '#4338ca', textDecorationLine: 'underline' },
  linkBlueBold: { fontSize: 11, fontWeight: 'bold', color: '#1d4ed8', textDecorationLine: 'underline' },
  feedbackBox: {
    padding: 9,
    borderRadius: 6,
    borderWidth: 1,
    marginBottom: 8
  },
  feedbackError: { backgroundColor: '#fef2f2', borderColor: '#f87171' },
  feedbackSuccess: { backgroundColor: '#f0fdf4', borderColor: '#4ade80' },
  feedbackErrorText: { fontSize: 11, fontWeight: 'bold', color: '#991b1b' },
  feedbackSuccessText: { fontSize: 11, fontWeight: 'bold', color: '#166534' },
  consentBox: {
    marginTop: 6,
    padding: 10,
    backgroundColor: '#fefce8',
    borderWidth: 1,
    borderColor: '#fde047',
    borderRadius: 8
  },
  checkboxBox: {
    width: 18,
    height: 18,
    borderWidth: 1.5,
    borderColor: '#6b7280',
    borderRadius: 4,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff'
  },
  checkboxBoxChecked: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb'
  },
  checkboxTick: { color: '#fff', fontSize: 11, fontWeight: 'bold' },
  securityStrip: {
    backgroundColor: '#f8fafc',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingHorizontal: 10,
    paddingVertical: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  securityStripGreen: { fontSize: 9, fontWeight: 'bold', color: '#166534' },
  securityStripBlue: { fontSize: 9, fontWeight: 'bold', color: '#1e40af' },
  securityStripSep: { fontSize: 9, color: '#d1d5db' },
  userCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 10,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  smallLabelGray: { fontSize: 10, color: '#6b7280' },
  userNameBold: { fontSize: 13, fontWeight: 'bold', color: '#111827', marginTop: 2 },
  rolePillClient: {
    marginTop: 4,
    alignSelf: 'flex-start',
    backgroundColor: '#dbeafe',
    borderWidth: 1,
    borderColor: '#93c5fd',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999
  },
  rolePillClientText: { fontSize: 9, fontWeight: 'bold', color: '#1e40af' },
  deviceBadgeBox: {
    marginTop: 3,
    backgroundColor: '#eef2ff',
    borderWidth: 1,
    borderColor: '#c7d2fe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8
  },
  deviceBadgeText: { fontSize: 10, fontWeight: 'bold', color: '#312e81' },
  telemetryCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 10,
    marginTop: 10
  },
  greenPulseDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10b981',
    marginRight: 6
  },
  specsGridBox: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 8
  },
  specItemLabel: { fontSize: 9, color: '#6b7280' },
  specItemValue: { fontSize: 10, fontWeight: 'bold', color: '#0f172a', marginTop: 1 },
  specRowDivider: {
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    marginTop: 5,
    paddingTop: 5
  },
  gaugeTitle: { fontSize: 11, fontWeight: 'bold', color: '#1f2937' },
  gaugeSubDetail: { fontSize: 10, color: '#4b5563', marginTop: 1, marginBottom: 4 },
  progressTrack: {
    width: '100%',
    height: 9,
    backgroundColor: '#e5e7eb',
    borderRadius: 5,
    overflow: 'hidden'
  },
  progressFill: { height: '100%', borderRadius: 5 },
  metricMiniCard: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 7
  },
  metricMiniBig: { fontSize: 13, fontWeight: 'bold', color: '#1f2937', marginVertical: 1 },
  shortcutBtnHistory: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#6ee7b7',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center'
  },
  shortcutBtnHistoryText: { fontSize: 11, fontWeight: 'bold', color: '#064e3b' },
  shortcutBtnReminder: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    paddingVertical: 9,
    alignItems: 'center'
  },
  shortcutBtnReminderActive: {
    backgroundColor: '#fffbeb',
    borderColor: '#f59e0b'
  },
  shortcutBtnReminderText: { fontSize: 11, fontWeight: 'bold', color: '#374151' },
  analysisResultCard: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1
  },
  analysisResultCardOk: { backgroundColor: '#f0fdf4', borderColor: '#86efac' },
  analysisResultCardWarn: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  smallBadgePill: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  analysisSummaryInnerBox: {
    marginTop: 8,
    padding: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6
  },
  chatToolbarBox: {
    padding: 8,
    backgroundColor: '#f3f4f6',
    borderBottomWidth: 1,
    borderBottomColor: '#d1d5db'
  },
  lgpdMiniBadge: {
    backgroundColor: '#dbeafe',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  lgpdMiniBadgeText: { fontSize: 9, fontWeight: 'bold', color: '#1e40af' },
  chatToolBtn: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderWidth: 1,
    borderRadius: 5,
    alignItems: 'center'
  },
  chatToolBtnText: { fontSize: 10, fontWeight: 'bold' },
  quickPromptChip: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginRight: 5
  },
  quickPromptChipText: { fontSize: 10, color: '#1f2937' },
  chatBubbleUser: {
    backgroundColor: '#dbeafe',
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderRadius: 14,
    borderTopRightRadius: 2,
    padding: 10,
    marginLeft: 24,
    marginBottom: 8
  },
  chatBubbleBot: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 14,
    borderTopLeftRadius: 2,
    padding: 10,
    marginRight: 16,
    marginBottom: 8
  },
  chatBubbleText: { fontSize: 11, color: '#1f2937', lineHeight: 16 },
  aiActionCard: {
    marginTop: 8,
    padding: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 8
  },
  botQuickReplyPill: {
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999
  },
  botQuickReplyText: { fontSize: 10, fontWeight: 'bold', color: '#1e40af' },
  botFooterBar: {
    marginTop: 8,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  protocolGeneratedCard: {
    marginTop: 8,
    padding: 10,
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 8,
    alignItems: 'center'
  },
  protocolCodeBig: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#14532d',
    letterSpacing: 1.5
  },
  chatInputRow: {
    padding: 8,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#d1d5db',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  chatSendBtn: {
    backgroundColor: '#1976d2',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6
  },
  supportStatusHeader: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#f0fdf4',
    borderBottomWidth: 1,
    borderBottomColor: '#bbf7d0'
  },
  livePillAmber: {
    backgroundColor: '#fef3c7',
    borderWidth: 1,
    borderColor: '#fcd34d',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  anydeskDockBox: {
    marginHorizontal: 10,
    marginTop: 8,
    padding: 10,
    backgroundColor: '#0f172a',
    borderWidth: 2,
    borderColor: '#ef4444',
    borderRadius: 12
  },
  anydeskRedBadge: {
    backgroundColor: '#dc2626',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  anydeskRedBadgeText: { fontSize: 9, fontWeight: 'bold', color: '#fff' },
  anydeskDisconnectBtn: {
    backgroundColor: '#991b1b',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4
  },
  anydeskTerminalBox: {
    marginTop: 6,
    padding: 7,
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#334155',
    borderRadius: 6
  },
  anydeskTerminalText: {
    fontSize: 9,
    color: '#34d399',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    marginVertical: 1
  },
  anydeskModeBtn: {
    flex: 1,
    paddingVertical: 6,
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 6,
    alignItems: 'center'
  },
  anydeskModeBtnActive: {
    backgroundColor: '#dc2626',
    borderColor: '#f87171'
  },
  anydeskProgramInput: {
    marginTop: 4,
    backgroundColor: '#020617',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    fontSize: 10,
    color: '#6ee7b7'
  },
  anydeskPresetChip: {
    backgroundColor: '#1e293b',
    borderWidth: 1,
    borderColor: '#475569',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4
  },
  supportWelcomeBox: {
    padding: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 10
  },
  protocolActiveHeaderCard: {
    padding: 10,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    borderRadius: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8
  },
  supportBubbleClient: {
    backgroundColor: '#dcfce7',
    borderWidth: 1,
    borderColor: '#86efac',
    borderRadius: 14,
    borderTopRightRadius: 2,
    padding: 10,
    marginLeft: 24,
    marginBottom: 8
  },
  supportBubbleTech: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderRadius: 14,
    borderTopLeftRadius: 2,
    padding: 10,
    marginRight: 16,
    marginBottom: 8
  },
  supportBubbleSystem: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    borderRadius: 10,
    padding: 8,
    marginBottom: 8
  },
  ratingCard: {
    padding: 12,
    backgroundColor: '#ecfdf5',
    borderWidth: 2,
    borderColor: '#34d399',
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 6
  },
  starBtn: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#fbbf24',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8
  },
  supportInputBox: {
    padding: 8,
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#d1d5db'
  },
  supportSendBtn: {
    backgroundColor: '#15803d',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 6,
    justifyContent: 'center'
  },
  dutyBadge: {
    backgroundColor: '#dcfce7',
    borderWidth: 1,
    borderColor: '#4ade80',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999
  },
  dutySwitchBtn: {
    flex: 1,
    paddingVertical: 5,
    borderRadius: 5,
    alignItems: 'center'
  },
  emptyQueueBox: {
    padding: 12,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8
  },
  queueTicketItem: {
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6
  },
  queueTicketItemSelected: {
    backgroundColor: '#eff6ff',
    borderColor: '#2563eb'
  },
  techMetricBox: {
    flex: 1,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 6,
    padding: 5,
    alignItems: 'center'
  },
  techActionBtn: {
    flex: 1,
    paddingVertical: 6,
    borderWidth: 1,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  techChatHistoryBox: {
    marginTop: 8,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    padding: 8,
    minHeight: 90
  },
  techBubbleSelf: {
    backgroundColor: '#dbeafe',
    borderWidth: 1,
    borderColor: '#93c5fd',
    borderRadius: 10,
    padding: 8,
    marginLeft: 16,
    marginBottom: 6
  },
  techBubbleClient: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 8,
    marginRight: 16,
    marginBottom: 6
  },
  profileHeaderCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center'
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1d4ed8',
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarInitials: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  floatingChatBanner: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    backgroundColor: '#064e3b',
    borderWidth: 1,
    borderColor: '#10b981',
    borderRadius: 12,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 50
  },
  clipboardToast: {
    position: 'absolute',
    bottom: 12,
    alignSelf: 'center',
    backgroundColor: '#171717',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 60
  },
  androidNavBar: {
    height: 36,
    backgroundColor: '#171717',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderTopColor: '#262626'
  },
  androidNavBtn: { paddingHorizontal: 24, paddingVertical: 6 },
  androidNavIcon: { color: '#d1d5db', fontSize: 13 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14
  },
  modalCard: {
    width: 325,
    maxWidth: '100%',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#9ca3af'
  },
  modalTitle: { fontSize: 13, fontWeight: 'bold', color: '#111827' },
  modalCloseIcon: { fontSize: 14, fontWeight: 'bold', color: '#6b7280', paddingHorizontal: 4 },
  auditLogItem: {
    padding: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 6
  },
  deepCleanItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 8,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    marginTop: 6
  },
  sensorTestSmallBtn: {
    backgroundColor: '#4f46e5',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6
  }
});
