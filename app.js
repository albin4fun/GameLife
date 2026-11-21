"use strict";

const STORAGE_KEY = "life-rpg-state";
const DATABASE_NAME = "life-rpg";
const DATABASE_VERSION = 1;
const RANKS = [
  ["Bois", 0], ["Pierre", 100], ["Marbre", 250], ["Fer", 450],
  ["Cuivre", 700], ["Argent", 1_000], ["Or", 1_400], ["Platine", 1_900],
  ["Diamant", 2_500], ["Émeraude", 3_300], ["Saphir", 4_300], ["Rubis", 5_500],
  ["Génie", 7_000], ["Champion", 9_000], ["Légende", 12_000], ["Ultime", 16_000]
];
const DOMAIN_COLORS = {
  "Santé": "#10b981", "Études": "#38bdf8", "Projets": "#fb923c", "Bien-être": "#a855f7"
};
const todayKey = () => new Date().toLocaleDateString("sv-SE");
const weekKey = (dateKey = todayKey()) => {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date.toLocaleDateString("sv-SE");
};
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);
const initialState = () => ({
  version: 1,
  date: todayKey(),
  weekStart: weekKey(),
  hero: "Albin",
  accent: "#aeb5bc",
  radius: 22,
  apiKey: "",
  bankedXP: 0,
  freezeTokens: 1,
  quests: [
    { id: uid(), name: "Sommeil ≥ 7h30", domain: "Santé", xp: 10, period: "daily", done: false },
    { id: uid(), name: "Séance de sport", domain: "Santé", xp: 25, period: "daily", done: false },
    { id: uid(), name: "Révision Polytech · 1h", domain: "Études", xp: 15, period: "daily", done: false },
    { id: uid(), name: "Défi du jour · 45 min de concentration", domain: "Études", xp: 50, period: "super", done: false },
    { id: uid(), name: "Grand ménage & rangement", domain: "Bien-être", xp: 50, period: "urgent", created: todayKey(), done: false },
    { id: uid(), name: "Projet personnel · étape 2/3", domain: "Projets", xp: 30, period: "weekly", done: false }
  ],
  logs: {},
  quick: {},
  todos: ["Préparer les priorités de la journée"],
  events: [],
  messages: []
});

let state;
let db;
let activeTab = "home";
let installPrompt;
let pendingAttachment = null;
let toastTimer;
const view = document.querySelector("#view");
const modal = document.querySelector("#modal");
const modalContent = document.querySelector("#modal-content");

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB n'est pas disponible dans ce navigateur."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore("app", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Impossible d'ouvrir la base locale."));
  });
}

function readDatabase() {
  return new Promise((resolve, reject) => {
    const request = db.transaction("app", "readonly").objectStore("app").get("state");
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error || new Error("Lecture des données impossible."));
  });
}

function writeDatabase(value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("app", "readwrite");
    transaction.objectStore("app").put({ id: "state", value });
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Écriture des données impossible."));
  });
}

async function loadState() {
  try {
    db = await openDatabase();
    const stored = await readDatabase();
    if (stored) return stored;
    const fallback = localStorage.getItem(STORAGE_KEY);
    if (fallback) {
      const restored = JSON.parse(fallback);
      await writeDatabase(restored);
      return restored;
    }
    return initialState();
  } catch (error) {
    console.error("Stockage IndexedDB indisponible :", error);
    showToast("Stockage de secours activé sur cet appareil.");
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? JSON.parse(saved) : initialState();
    } catch (fallbackError) {
      console.error("Stockage local indisponible :", fallbackError);
      showToast("Le stockage local est bloqué. Les changements risquent de ne pas être conservés.");
      return initialState();
    }
  }
}

async function persist() {
  try {
    if (db) await writeDatabase(state);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Sauvegarde locale impossible :", error);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      showToast("Sauvegarde IndexedDB indisponible : copie locale de secours utilisée.");
    } catch (fallbackError) {
      console.error("Sauvegarde de secours impossible :", fallbackError);
      showToast("Erreur : les données ne peuvent pas être sauvegardées.");
    }
  }
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function dayLog(date = todayKey()) {
  return state.logs[date] || { xp: 0, quests: 0, totalQuests: 0 };
}

function currentQuestsXP() {
  return state.quests.reduce((sum, quest) => sum + (
    quest.done && (!quest.completedOn || quest.completedOn === todayKey()) ? questValue(quest) : 0
  ), 0);
}

function questValue(quest) {
  if (quest.period !== "urgent") return Number(quest.xp) || 0;
  const lateDays = Math.max(0, Math.floor((Date.now() - new Date(`${quest.created}T00:00:00`).getTime()) / 86_400_000));
  return Math.max(0, (Number(quest.xp) || 0) - lateDays * 10);
}

function updateTodayLog() {
  const done = state.quests.filter(quest => quest.done && (!quest.completedOn || quest.completedOn === todayKey())).length;
  state.logs[todayKey()] = {
    ...dayLog(),
    xp: currentQuestsXP(),
    quests: done,
    totalQuests: state.quests.length
  };
}

function rollDayIfNeeded() {
  const currentDate = todayKey();
  if (state.date === currentDate) return;
  state.bankedXP = (Number(state.bankedXP) || 0) + (Number(state.logs[state.date]?.xp) || 0);
  state.date = currentDate;
  const currentWeek = weekKey(currentDate);
  if (state.weekStart !== currentWeek) {
    state.quests = state.quests.map(quest => (
      quest.period === "weekly" ? { ...quest, done: false, completedOn: null } : quest
    ));
    state.weekStart = currentWeek;
  }
  state.quests = state.quests.map(quest => (
    quest.period === "daily" || quest.period === "urgent" || quest.period === "super"
      ? { ...quest, done: false, completedOn: null }
      : quest
  ));
  state.quick = {};
  updateTodayLog();
}

function streakLength() {
  let date = new Date(`${todayKey()}T00:00:00`);
  let count = 0;
  while (true) {
    const key = date.toLocaleDateString("sv-SE");
    if ((Number(state.logs[key]?.xp) || 0) < 20) break;
    count++;
    date.setDate(date.getDate() - 1);
  }
  return count;
}

function rankForXP(total) {
  let rankIndex = 0;
  for (let i = 0; i < RANKS.length; i++) {
    if (total >= RANKS[i][1]) rankIndex = i;
    else break;
  }
  const nextThreshold = RANKS[rankIndex + 1]?.[1] || RANKS[rankIndex][1] + 4_000;
  const previousThreshold = RANKS[rankIndex][1];
  const divisionProgress = (total - previousThreshold) / (nextThreshold - previousThreshold);
  const division = Math.min(3, Math.floor(divisionProgress * 4));
  const divisionNames = ["Novice", "Avancé", "Expert", "Maître"];
  return {
    name: RANKS[rankIndex][0],
    division: divisionNames[division],
    total,
    next: nextThreshold,
    progress: Math.max(0, Math.min(100, ((total - previousThreshold) / (nextThreshold - previousThreshold)) * 100))
  };
}

function renderTopbar() {
  const total = (Number(state.bankedXP) || 0) + currentQuestsXP();
  const rank = rankForXP(total);
  document.querySelector("#xp-fill").style.width = `${rank.progress}%`;
  const currentThreshold=RANKS.find(item=>item[0]===rank.name)?.[1]||0;
  const maxRankProgress=Math.min(100,((total+state.quests.filter(q=>!q.done).reduce((n,q)=>n+questValue(q),0)-currentThreshold)/(rank.next-currentThreshold))*100);
  const potential=document.querySelector("#xp-potential"); potential.style.left=`${rank.progress}%`; potential.style.width=`${Math.max(0,maxRankProgress-rank.progress)}%`;
  document.querySelector("#xp-total").textContent = `${total} XP`;
  document.querySelector("#xp-next").textContent = `${rank.next} XP`;
  document.querySelector("#streak-count").textContent = `${streakLength()}j`;
  const emblem=document.querySelector("#rank-button"); emblem.classList.remove("rank-rune-1","rank-rune-2","rank-rune-3"); emblem.classList.add(`rank-rune-${Math.min(3,Math.floor(RANKS.findIndex(item=>item[0]===rank.name)/5)+1)}`);
  document.querySelector("#rank-caption").textContent = `${rank.name.toLocaleUpperCase("fr-FR")} · ${rank.division}`;
  if (!state.accent || state.accent.toLowerCase()==="#38bdf8") state.accent="#aeb5bc";
  document.documentElement.style.setProperty("--accent", state.accent);
  document.documentElement.style.setProperty("--radius", `${Math.max(8, Math.min(32, Number(state.radius) || 22))}px`);
}

function header(title, eyebrow, extra = "") {
  return `<div class="page-title"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1></div>${extra}</div>`;
}

function renderQuest(quest) {
  const done = quest.done ? " done" : "";
  const category = quest.period === "super" ? "Super quête" : quest.period === "weekly" ? "Hebdomadaire" : quest.period === "urgent" ? "Urgence dégressive" : quest.domain;
  return `<article class="quest${done}" data-quest="${escapeHtml(quest.id)}">
    <button class="quest-check" data-action="toggle-quest" data-id="${escapeHtml(quest.id)}" aria-label="${quest.done ? "Décocher" : "Valider"} ${escapeHtml(quest.name)}">${quest.done ? "✓" : ""}</button>
    <div class="quest-info"><div class="quest-name">${escapeHtml(quest.name)}</div><div class="quest-detail">${escapeHtml(category)}${quest.period === "urgent" ? ` · −10 XP/jour · aujourd'hui ${questValue(quest)} XP` : ""}</div></div>
    <span class="quest-points">+${questValue(quest)} XP</span>
    <button class="quest-delete" data-action="delete-quest" data-id="${escapeHtml(quest.id)}" aria-label="Supprimer la quête">×</button>
  </article>`;
}

function questGroup(title, quests, extraClass = "") {
  return `<div class="section-label">${title}</div><div class="quest-list ${extraClass}">${quests.length ? quests.map(renderQuest).join("") : '<div class="empty">Aucune quête ici pour le moment.</div>'}</div>`;
}

function domainProgress() {
  return Object.keys(DOMAIN_COLORS).map(domain => {
    const quests = state.quests.filter(quest => quest.domain === domain);
    const done = quests.filter(quest => quest.done).length;
    return { domain, color: DOMAIN_COLORS[domain], value: quests.length ? Math.round(done / quests.length * 100) : 0 };
  });
}

function renderHome() {
  const activity = [
    {domain:"Sant\u00e9",value:(Number(state.quick.sport)||0)+(Number(state.quick.sleep)||0)},
    {domain:"\u00c9tudes",value:Number(state.quick.study)||0},
    {domain:"Projets",value:Number(state.quick.reading)||0},
    {domain:"Bien-\u00eatre",value:(Number(state.quick.outside)||0)+(Number(state.quick.screen)||0)}
  ];
  state.quests.filter(q=>q.done&&(!q.completedOn||q.completedOn===todayKey())).forEach(q=>{const x=activity.find(v=>v.domain===q.domain);if(x)x.value+=1;});
  const total=activity.reduce((n,x)=>n+x.value,0);let cursor=0;
  const segments=total?activity.map(x=>{const width=x.value/total*100,start=cursor;cursor+=width;return `${DOMAIN_COLORS[x.domain]} ${start}% ${cursor}%`;}).join(", "):"#252a2e 0 100%";
  const activeDomains=activity.filter(x=>x.value>0).length;
  const today=new Date().toLocaleDateString("fr-FR",{weekday:"long",day:"numeric",month:"long"});
  const doneCount=state.quests.filter(q=>q.done&&(!q.completedOn||q.completedOn===todayKey())).length;
  const daily=state.quests.filter(q=>q.period==="daily"&&(!q.done||q.completedOn!==todayKey()));
  const todos=state.todos.slice(0,3).map(x=>`<div class="recap-line"><span>\ud83d\udccc</span>${escapeHtml(x)}</div>`).join("");
  const events=state.events.slice(0,3).map(x=>`<div class="recap-line"><span class="countdown">${escapeHtml(x.when)}</span>${escapeHtml(x.name)}</div>`).join("");
  const suggestion=total?(activity.find(x=>!x.value)?`Accorde un peu de temps \u00e0 ${activity.find(x=>!x.value).domain.toLowerCase()} aujourd'hui.`:"Belle journ\u00e9e \u00e9quilibr\u00e9e. Garde ton rythme."):"Une courte sortie ou 30 min de r\u00e9vision peuvent lancer ta journ\u00e9e.";
  view.innerHTML=`${header("Accueil",escapeHtml(today))}
    <p class="motivation">Les petits pas répétés font les grandes progressions.</p>
    <section class="card"><div class="card-title"><span>Activit\u00e9 de ta journ\u00e9e</span><span class="tag">${activeDomains}/4 domaines actifs</span></div>
      <div class="donut-area"><div class="donut" style="background:conic-gradient(${segments})"><div class="donut-center"><strong>${total?"?":"0"}</strong><span>${total?"activit\u00e9 saisie":"pas encore de donn\u00e9es"}</span></div></div>
      <div class="legend">${activity.map(x=>`<div class="legend-row"><i class="dot" style="background:${DOMAIN_COLORS[x.domain]};opacity:${x.value?1:.22}"></i>${escapeHtml(x.domain)}<b style="margin-left:auto">${total?Math.round(x.value/total*100):0}%</b></div>`).join("")}</div></div></section>
    <div class="coach-note">\u2726 <b>Suggestion :</b> ${suggestion}<br><span class="hint">Conseil du coach IA ? Configure Gemini dans Profil pour personnaliser ces retours.</span></div>
    <section class="card" style="margin-top:13px"><div class="card-title"><span>Qu\u00eates du jour</span><button class="tag cyan" data-action="navigate" data-tab="quests">Tout voir \u2192</button></div><div class="quest-list">${daily.slice(0,3).map(renderQuest).join("")}</div></section>
    <section class="card"><div class="card-title"><span>Ton r\u00e9cap du jour</span><span class="tag">${doneCount}/${state.quests.length} faites</span></div>
      <div class="section-label" style="margin-top:0">\u00c0 ne pas oublier</div>${todos||'<div class="hint">Aucune t\u00e2che ajout\u00e9e.</div>'}
      <div class="section-label">\u00c0 venir</div>${events||'<div class="hint">Ajoute un rappel avec la mise \u00e0 jour rapide.</div>'}</section>`;
}

function renderQuests() {
  const active = quest => !quest.done || (quest.completedOn && quest.completedOn !== todayKey());
  const daily = state.quests.filter(quest => quest.period === "daily" && active(quest));
  const special = state.quests.filter(quest => quest.period === "super" && active(quest));
  const urgent = state.quests.filter(quest => quest.period === "urgent" && active(quest));
  const weekly = state.quests.filter(quest => quest.period === "weekly" && active(quest));
  const done = state.quests.filter(quest => quest.done && (!quest.completedOn || quest.completedOn === todayKey()));
  view.innerHTML = `${header("Centre de quêtes", "Chaque effort compte", '<button class="btn primary" data-action="navigate" data-tab="assistant">Parler &agrave; l&rsquo;assistant</button>')}
    ${questGroup("Quêtes journalières", daily)}
    ${questGroup("Super quête", special, "urgent-card")}
    ${questGroup("À faire · urgence dégressive", urgent, "urgent-card")}
    ${questGroup("Quête hebdomadaire", weekly)}
    <div class="section-label">Qu&ecirc;tes effectu&eacute;es · Aujourd'hui</div><section class="card">${done.length ? done.map(quest => `<div class="recap-line"><span>✅</span><span>${escapeHtml(quest.name)}</span><b style="margin-left:auto;color:var(--accent)">+${questValue(quest)} XP</b></div>`).join("") : '<div class="empty">Tes quêtes validées apparaîtront ici.</div>'}</section>
    <section class="card"><div class="card-title"><span>Progression du jour</span><span class="tag cyan">${currentQuestsXP()} XP</span></div><div class="hint">Le gain de chaque quête est ajouté à ton total. Tu peux décocher une quête : les XP sont alors retirés. Une tâche urgente perd 10 XP par jour de retard.</div></section>`;
}

function radarSvg(values) {
  const points = [0, 1, 2, 3, 4].map(index => {
    const angle = (-Math.PI / 2) + index * (Math.PI * 2 / 5);
    const radius = 73 * Math.max(.12, Math.min(1, values[index] / 100));
    return `${100 + Math.cos(angle) * radius},${100 + Math.sin(angle) * radius}`;
  }).join(" ");
  const grid = [25, 50, 75, 100].map(level => {
    const ring = [0, 1, 2, 3, 4].map(index => {
      const angle = (-Math.PI / 2) + index * (Math.PI * 2 / 5);
      return `${100 + Math.cos(angle) * 73 * level / 100},${100 + Math.sin(angle) * 73 * level / 100}`;
    }).join(" ");
    return `<polygon points="${ring}" fill="none" stroke="#334155" stroke-width="1"/>`;
  }).join("");
  return `<svg class="radar" viewBox="0 0 200 200" role="img" aria-label="Radar de compétences"><g>${grid}
    <polygon points="${points}" fill="#38bdf833" stroke="var(--accent)" stroke-width="2"/>
    ${values.map((value, index) => {
      const angle = (-Math.PI / 2) + index * (Math.PI * 2 / 5);
      return `<text x="${100 + Math.cos(angle) * 93}" y="${100 + Math.sin(angle) * 93}" fill="#cbd5e1" text-anchor="middle" dominant-baseline="middle" font-size="8">${["Santé", "Études", "Projets", "Bien-être", "Discipline"][index]}</text>`;
    }).join("")}</g></svg>`;
}

function lastDays(count) {
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    dates.push(date);
  }
  return dates;
}

function renderStats() {
  const progress = domainProgress();
  const values = [progress[0]?.value || 0, progress[1]?.value || 0, progress[2]?.value || 0, progress[3]?.value || 0, Math.min(100, Math.round(currentQuestsXP() / 100 * 100))];
  const days = lastDays(28);
  const heat = days.map(date => {
    const key = date.toLocaleDateString("sv-SE");
    const log = state.logs[key];
    const ratio = log && log.totalQuests ? log.quests / log.totalQuests : 0;
    const level = ratio >= .75 ? "level-3" : ratio >= .4 ? "level-2" : ratio > 0 ? "level-1" : "";
    return `<div class="heat-day ${level}${key === todayKey() ? " today" : ""}" title="${key} · ${Math.round(ratio * 100)}%" aria-label="${key} · ${Math.round(ratio * 100)}%">${date.getDate()}</div>`;
  }).join("");
  const month = new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const monthCells = [];
  const firstDay = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getDay();
  const offset = (firstDay + 6) % 7;
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
  for (let i = 0; i < offset; i++) monthCells.push('<span></span>');
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(new Date().getFullYear(), new Date().getMonth(), day);
    const key = date.toLocaleDateString("sv-SE");
    const log = state.logs[key];
    const status = key > todayKey() ? "" : log?.quests > 0 ? "done" : key < todayKey() ? "missed" : "";
    monthCells.push(`<div class="heat-day ${status === "done" ? "level-2" : status === "missed" ? "missed-day" : ""}${key === todayKey() ? " today" : ""}" title="${key}">${day}</div>`);
  }
  view.innerHTML = `${header("Suivi & tâches", "Tes progrès, sans pression")}
    <section class="card stats-radar"><div class="card-title"><span>Compétences RPG</span><span class="tag cyan">Mois actuel</span></div><div class="radar-wrap">${radarSvg(values)}</div>
      ${progress.map(item => `<div class="domain-row"><span>${escapeHtml(item.domain)}</span><span class="domain-bar"><i style="width:${item.value}%;--bar-color:${item.color}"></i></span><b>${item.value}</b></div>`).join("")}
    </section>
    ${state.visualization ? `<section class="card"><div class="card-title"><span>${state.visualization === "calendar" ? "Calendrier d?activite" : "Evolution XP ? 7 jours"}</span><button class="tag" data-action="remove-visual">Retirer</button></div>${state.visualization === "calendar" ? `<div class="heatmap">${monthCells.join("")}</div>` : `<div class="mini-chart">${lastDays(7).map((date,index)=>{const xp=Number(state.logs[date.toLocaleDateString("sv-SE")]?.xp)||0;return `<div title="${xp} XP" style="height:${Math.max(4,Math.min(100,xp/2))}%"><small>${["L","M","M","J","V","S","D"][index]}</small></div>`;}).join("")}</div>`}</section>` : ""}
    <button class="visual-add" data-action="add-visual" aria-label="Ajouter une visualisation">+</button>
    <section class="card"><div class="card-title"><span>Régularité · 28 derniers jours</span><span class="tag green">${streakLength()}j de série</span></div>
      <div class="heatmap">${heat}</div><div class="hint" style="margin-top:10px">La bordure cyan marque aujourd'hui · plus le vert est vif, plus les quêtes sont complétées.</div>
    </section>
    <section class="card"><div class="card-title"><span>Calendrier des quêtes</span><span class="tag">${escapeHtml(month)}</span></div>
      <div class="heatmap">${["L","M","M","J","V","S","D"].map(day => `<div class="hint" style="text-align:center">${day}</div>`).join("")}${monthCells.join("")}</div>
      <div class="hint" style="margin-top:10px">Vert : activité enregistrée · Rouge : journée terminée sans quête validée · Gris : à venir.</div>
    </section>

    <section class="card"><div class="card-title"><span>Mesures récentes</span><span class="tag">Saisie rapide</span></div>
      <div class="dashboard-grid"><div class="metric"><div class="metric-label">Sommeil</div><div class="metric-value">${state.quick.sleep ? `${escapeHtml(state.quick.sleep)}h` : "—"}</div><div class="metric-sub">heures cette nuit</div></div>
      <div class="metric"><div class="metric-label">Révisions</div><div class="metric-value">${state.quick.study ? `${escapeHtml(state.quick.study)}h` : "—"}</div><div class="metric-sub">temps aujourd'hui</div></div>
      <div class="metric"><div class="metric-label">Lecture</div><div class="metric-value">${state.quick.reading ? `${escapeHtml(state.quick.reading)}m` : "—"}</div><div class="metric-sub">minutes aujourd'hui</div></div>
      <div class="metric"><div class="metric-label">Temps d'écran</div><div class="metric-value">${state.quick.screen ? `${escapeHtml(state.quick.screen)}h` : "—"}</div><div class="metric-sub">estimation du jour</div></div></div>
    </section>`;
}

function renderAssistant() {
  const messages = state.messages || [];
  const chat = messages.map(message => {
    const suggestion = message.role === "assistant" && message.text.match(/QUEST:\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(Santé|Études|Projets|Bien-être)/i);
    if (suggestion) {
      return `<div class="chat-msg">${escapeHtml(message.text)}<br><button class="btn success" data-action="accept-ai-quest" data-name="${escapeHtml(suggestion[1])}" data-xp="${escapeHtml(suggestion[2])}" data-domain="${escapeHtml(suggestion[3])}" style="margin-top:9px">＋ Accepter la quête</button></div>`;
    }
    return `<div class="chat-msg ${message.role === "user" ? "user" : ""}">${escapeHtml(message.text)}</div>`;
  }).join("");
  view.innerHTML = `${header("Assistant Polytech", "En ligne · clé Gemini requise")}
    <div class="coach-note" style="margin-bottom:12px">🔒 Les appels IA partent directement de ton téléphone vers Google. Ta clé API reste stockée sur cet appareil. N'envoie que des documents que tu acceptes de partager avec Google.</div>
    <div class="shortcut-row"><button class="shortcut" data-action="shortcut" data-prompt="Aide-moi à planifier mes prochaines révisions.">📅 Agenda DS</button><button class="shortcut" data-action="shortcut" data-prompt="Propose-moi une quête flash courte et réaliste.">⚡ Quête flash</button><button class="shortcut" data-action="shortcut" data-prompt="Aide-moi à analyser mon temps d'étude et mes résultats.">📊 Analyse notes</button></div>
    <section class="card chat-card"><div class="chat-log" id="chat-log">${chat || '<div class="chat-msg">Salut ! Je peux t’aider à organiser tes révisions, expliquer un cours ou proposer un défi. Configure ta clé Gemini dans Profil pour commencer.</div>'}</div>
      <div class="chat-form"><textarea class="input" id="chat-input" rows="1" placeholder="Écris ton message…"></textarea>
        <label class="btn subtle" for="chat-file" title="Joindre une image ou un PDF">＋</label><input id="chat-file" type="file" accept="image/*,application/pdf" hidden>
        <button class="btn primary" data-action="send-chat" aria-label="Envoyer">➤</button>
      </div><div class="hint" id="attachment-label" style="margin-top:6px"></div>
      <div class="fine-print">Pas de messages vocaux. Images et PDF sont envoyés à Google uniquement lors de l'envoi d'un message, si tu les joins.</div>
    </section>
    <button class="btn block" data-action="api-settings">🔑 Configurer ma clé Gemini</button>`;
  const log = document.querySelector("#chat-log");
  log.scrollTop = log.scrollHeight;
}

function renderProfile() {
  const rank = rankForXP((Number(state.bankedXP) || 0) + currentQuestsXP());
  view.innerHTML = `${header("Profil & héros", "Ta progression, tes règles")}
    <section class="card"><div class="card-title"><span>Arbre des accomplissements</span><span class="tag orange">Starter</span></div>
      <div class="achievement-tree"><div class="tree-root">D&eacute;part de l?aventure</div><div class="tree-branches"><div class="tree-node unlocked"><b>&#9673;</b><span>Premiers pas</span><small>10 XP &middot; d&eacute;bloqu&eacute;</small></div><div class="tree-node"><b>&#8961;</b><span>Rythme r&eacute;gulier</span><small>7 jours actifs</small></div><div class="tree-node"><b>&#9671;</b><span>Esprit studieux</span><small>15 h de r&eacute;visions</small></div><div class="tree-node"><b>&#10023;</b><span>H&eacute;ros accompli</span><small>30 jours actifs</small></div></div></div>
      <div class="fine-print">Les branches se d?bloquent avec tes activit?s. R?compenses cosm?tiques ? venir.</div></section>
    <section class="card"><div class="card-title"><span>🌳 Arbre des accomplissements</span><span class="tag orange">Starter</span></div>
      <div class="recap-line">🌙 <span>Maître de l'Aube · 14 nuits de sommeil régulier</span><span class="tag">À débloquer</span></div>
      <div class="recap-line">⚡ <span>Érudit Polytech · 15h de révisions hebdo</span><span class="tag">À débloquer</span></div>
      <div class="recap-line">🏆 <span>Légende de la régularité · Série de 30 jours</span><span class="tag">À débloquer</span></div>
      <div class="fine-print">Les cosmétiques et succès constituent un aperçu de la V1 ; aucun bonus de jeu n'est encore attribué.</div>
    </section>
    <section class="card"><div class="card-title"><span>⚙️ Personnalisation</span></div>
      <div class="setting-row"><label for="hero-name">Nom du héros</label><input class="input" id="hero-name" maxlength="24" value="${escapeHtml(state.hero)}" style="width:145px"></div>
      <div class="setting-row"><label for="accent-color">Couleur d'accent</label><input id="accent-color" type="color" value="${escapeHtml(state.accent)}"></div>
      <div class="setting-row"><label for="radius-range">Arrondis des cartes</label><input id="radius-range" type="range" min="8" max="32" value="${Number(state.radius) || 22}"><span class="range-value" id="radius-value">${Number(state.radius) || 22}px</span></div>
      <button class="btn block" data-action="api-settings">🔑 ${state.apiKey ? "Modifier" : "Configurer"} ma clé Gemini</button>
    </section>
    <section class="card"><div class="card-title"><span>🔐 Données & confidentialité</span><span class="tag green">Stockage local</span></div>
      <div class="hint">Tes quêtes et saisies restent dans le stockage de ce navigateur. Elles ne sont pas synchronisées ni sauvegardées sur un serveur. Pense à exporter une sauvegarde.</div>
      <div class="btn-row" style="margin-top:12px"><button class="btn subtle" data-action="export">Exporter JSON</button><button class="btn subtle" data-action="import">Importer JSON</button></div>
      <input id="import-file" type="file" accept="application/json,.json" hidden>
      <div class="fine-print">La clé Gemini est exclue des exports. Les fichiers d'export sont lisibles : garde-les en lieu sûr.</div>
    </section>
    <section class="card"><div class="card-title"><span>📲 Installer sur le téléphone</span></div><div class="hint">Une fois cette app publiée sur une adresse HTTPS : ouvre le lien dans Chrome Android, touche ⋮ puis « Installer l'application » ou « Ajouter à l'écran d'accueil ».</div><button class="btn block" data-action="install" style="margin-top:10px">Afficher les instructions d'installation</button></section>
    <section class="card"><div class="card-title"><span>Ce qui fonctionne déjà</span></div><div class="hint">Quêtes et XP · saisie express · graphiques locaux · configuration · export/import · consultation hors ligne après première ouverture.</div><div class="fine-print">La V1 ne planifie pas les notifications système ; l'assistant exige une clé Gemini et une connexion.</div></section>`;
}

function render() {
  rollDayIfNeeded();
  renderTopbar();
  document.querySelectorAll(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.tab === activeTab));
  document.querySelector("#quick-button").hidden = activeTab !== "home";
  const activeIndex = ["quests", "assistant", "home", "stats", "profile"].indexOf(activeTab);
  document.querySelector(".nav-dome").style.left = `${10 + activeIndex * 20}%`;
  if (activeTab === "quests") renderQuests();
  else if (activeTab === "assistant") renderAssistant();
  else if (activeTab === "stats") renderStats();
  else if (activeTab === "profile") renderProfile();
  else renderHome();
}

function openModal(title, body, submitText = "") {
  modalContent.innerHTML = `<div class="modal-head"><h2>${title}</h2><button class="close-button" type="button" data-action="close-modal" aria-label="Fermer">×</button></div>${body}${submitText ? `<button class="btn primary block" type="submit">${submitText}</button>` : ""}`;
  modal.showModal();
}

function openQuickUpdate() {
  openModal("Mise à jour express", `<div class="hint">Un petit bilan de ta journée, en moins de 2 minutes. Ces données restent sur ton appareil.</div>
    <div class="field"><label for="sleep">Sommeil (heures, ex. 7.5)</label><input class="input" id="sleep" name="sleep" type="number" min="0" max="24" step="0.25" value="${escapeHtml(state.quick.sleep || "")}" placeholder="7.5"></div>
    <div class="field"><label for="sport">Sport aujourd'hui</label><select class="select" id="sport" name="sport"><option value="">Pas de saisie</option><option value="fait" ${state.quick.sport === "fait" ? "selected" : ""}>Séance faite</option><option value="repos" ${state.quick.sport === "repos" ? "selected" : ""}>Repos prévu</option></select></div>
    <div class="field"><label for="study">Révisions (heures)</label><input class="input" id="study" name="study" type="number" min="0" max="24" step="0.25" value="${escapeHtml(state.quick.study || "")}" placeholder="1.5"></div>
    <div class="field"><label for="subject">Matière révisée</label><input class="input" id="subject" name="subject" maxlength="60" value="${escapeHtml(state.quick.subject || "")}" placeholder="Algèbre, électronique…"></div>
    <div class="field"><label for="reading">Lecture (minutes)</label><input class="input" id="reading" name="reading" type="number" min="0" max="1440" step="5" value="${escapeHtml(state.quick.reading || "")}" placeholder="20"></div>
    <div class="field"><label for="screen">Temps d'écran (heures)</label><input class="input" id="screen" name="screen" type="number" min="0" max="24" step="0.25" value="${escapeHtml(state.quick.screen || "")}" placeholder="2.25"></div>
    <div class="field"><label for="grade">Note reçue (optionnel, sur 20)</label><input class="input" id="grade" name="grade" type="number" min="0" max="20" step="0.25" value="${escapeHtml(state.quick.grade || "")}" placeholder="15.5"></div>
    <div class="field"><label for="todo">Ajouter une tâche / un devoir</label><input class="input" id="todo" name="todo" maxlength="120" placeholder="Ex. terminer la fiche d'algèbre"></div>
    <div class="field"><label for="event">Rappel à venir (optionnel)</label><input class="input" id="event" name="event" maxlength="80" placeholder="Ex. DS électronique · demain"></div>`, "Enregistrer mon bilan");
  modalContent.dataset.form = "quick";
}

function openNewQuest() {
  openModal("Créer une quête", `<div class="field"><label for="quest-name">Nom de la quête</label><input class="input" id="quest-name" name="name" maxlength="90" required placeholder="Ex. Réviser 30 minutes"></div>
    <div class="field"><label for="quest-domain">Domaine</label><select class="select" id="quest-domain" name="domain"><option>Santé</option><option>Études</option><option>Projets</option><option>Bien-être</option></select></div>
    <div class="field"><label for="quest-xp">Récompense (XP)</label><input class="input" id="quest-xp" name="xp" type="number" min="1" max="500" required value="15"></div>
    <div class="field"><label for="quest-type">Type</label><select class="select" id="quest-type" name="period"><option value="daily">Quête journalière</option><option value="super">Super quête</option><option value="weekly">Quête hebdomadaire</option><option value="urgent">Urgence dégressive (−10 XP/jour)</option></select></div>
    <div class="field-hint">Les quêtes sont conservées sur cet appareil. Les quêtes quotidiennes et urgentes se réinitialisent chaque jour ; les quêtes hebdomadaires le lundi.</div>`, "Ajouter la quête");
  modalContent.dataset.form = "quest";
}

function openApiSettings() {
  openModal("Clé API Gemini", `<p class="hint">La clé est enregistrée uniquement dans le stockage local de ce navigateur et utilisée directement depuis ton appareil pour appeler Google. Ne partage pas ta clé.</p>
    <div class="field"><label for="gemini-key">Clé API</label><input class="input" id="gemini-key" name="apiKey" type="password" autocomplete="off" value="${escapeHtml(state.apiKey)}" placeholder="AIza…"></div>
    <div class="field"><label for="gemini-model">Modèle Gemini</label><input class="input" id="gemini-model" name="model" value="${escapeHtml(state.model || "gemini-2.5-flash")}" placeholder="gemini-2.5-flash"></div>
    <div class="field-hint">La disponibilité des modèles dépend de ton compte et de l'API Google. La clé n'est pas incluse dans l'export de sauvegarde.</div>`, "Enregistrer");
  modalContent.dataset.form = "api";
}

function openInstallHelp() {
  const body = installPrompt
    ? `<p class="hint">Chrome peut ajouter Life RPG à ton écran d'accueil. Les données restent dans le navigateur de ce téléphone.</p><button class="btn primary block" type="button" data-action="confirm-install">Installer Life RPG</button>`
    : `<p class="hint">Pour que Chrome propose l'installation, la version de Life RPG doit être publiée sur une adresse sécurisée commençant par <b>https://</b>.</p><ol class="hint"><li>Publie le contenu du ZIP sur un hébergeur statique HTTPS.</li><li>Ouvre son lien dans Chrome sur ton Android.</li><li>Touche ⋮ puis « Installer l'application » (ou « Ajouter à l'écran d'accueil »).</li></ol><p class="hint">Après la première ouverture, l'app et ses fonctions locales sont disponibles hors ligne.</p>`;
  openModal("Installer Life RPG", body);
}

function saveQuick(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  state.quick = { ...state.quick };
  ["sleep", "study", "reading", "screen", "grade"].forEach(key => {
    if (values[key] !== "") state.quick[key] = Number(values[key]);
  });
  ["sport", "subject"].forEach(key => {
    if (values[key]) state.quick[key] = values[key];
  });
  if (values.todo?.trim()) state.todos.unshift(values.todo.trim());
  if (values.event?.trim()) state.events.unshift({ name: values.event.trim(), when: "À venir" });
  if (values.sport === "fait") {
    const quest = state.quests.find(item => item.period === "daily" && item.domain === "Santé" && /sport|séance/i.test(item.name));
    if (quest) {
      quest.done = true;
      quest.completedOn = todayKey();
    }
  }
  updateTodayLog();
  persist();
  modal.close();
  render();
  showToast("Bilan enregistré sur cet appareil.");
}

function saveQuest(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  const quest = {
    id: uid(),
    name: values.name.trim(),
    domain: values.domain,
    xp: Math.max(1, Math.min(500, Number(values.xp) || 1)),
    period: values.period,
    created: todayKey(),
    done: false
  };
  if (!quest.name) return;
  state.quests.push(quest);
  updateTodayLog();
  persist();
  modal.close();
  render();
  showToast("Quête ajoutée !");
}

function saveApiSettings(form) {
  const values = Object.fromEntries(new FormData(form).entries());
  state.apiKey = String(values.apiKey || "").trim();
  state.model = String(values.model || "gemini-2.5-flash").trim();
  persist();
  modal.close();
  render();
  showToast(state.apiKey ? "Clé enregistrée uniquement sur cet appareil." : "Clé API supprimée.");
}

function dataForExport() {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.apiKey;
  return copy;
}

function exportData() {
  const file = new Blob([JSON.stringify(dataForExport(), null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = `life-rpg-sauvegarde-${todayKey()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  showToast("Sauvegarde JSON exportée (sans clé API).");
}

function importData(file) {
  const reader = new FileReader();
  reader.onerror = () => showToast("Impossible de lire ce fichier JSON.");
  reader.onload = async () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!incoming || incoming.version !== 1 || !Array.isArray(incoming.quests) || typeof incoming.logs !== "object") {
        throw new Error("Format Life RPG non reconnu.");
      }
      const apiKey = state.apiKey;
      state = { ...initialState(), ...incoming, apiKey };
      rollDayIfNeeded();
      await persist();
      render();
      showToast("Sauvegarde importée.");
    } catch (error) {
      console.error("Import de sauvegarde refusé :", error);
      showToast(`Import refusé : ${error.message}`);
    }
  };
  reader.readAsText(file);
}

function fileToInlineData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture de la pièce jointe impossible."));
    reader.onload = () => {
      const encoded = String(reader.result).split(",")[1];
      if (!encoded) reject(new Error("Fichier joint vide ou non lisible."));
      else resolve({ mimeType: file.type || "application/octet-stream", data: encoded });
    };
    reader.readAsDataURL(file);
  });
}

async function sendChat(prompt) {
  const text = prompt.trim();
  if (!text && !pendingAttachment) return;
  if (!state.apiKey) {
    showToast("Configure d'abord ta clé API Gemini dans Profil.");
    openApiSettings();
    return;
  }
  const attachment = pendingAttachment;
  pendingAttachment = null;
  const input = document.querySelector("#chat-input");
  if (input) input.value = "";
  state.messages.push({ role: "user", text: `${text || "Analyse cette pièce jointe."}${attachment ? `\n[Pièce jointe : ${attachment.name}]` : ""}` });
  render();
  view.querySelector("#chat-log")?.scrollIntoView({ block: "end", behavior: "smooth" });
  try {
    const parts = [];
    if (text) parts.push({ text });
    if (attachment) parts.push({ inlineData: await fileToInlineData(attachment) });
    const contents = state.messages.slice(-12).map(message => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.text }]
    }));
    contents[contents.length - 1] = { role: "user", parts };
    const model = encodeURIComponent(state.model || "gemini-2.5-flash");
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": state.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "Tu es l'assistant de Life RPG. Réponds en français, sois bienveillant et pratique. Pour une suggestion de quête, termine par une ligne au format QUEST: titre | XP | domaine (Santé, Études, Projets ou Bien-être)." }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1200 }
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `Erreur API (${response.status}).`);
    const answer = payload.candidates?.[0]?.content?.parts?.map(part => part.text || "").join("").trim();
    if (!answer) throw new Error("L'API n'a pas renvoyé de réponse textuelle.");
    state.messages.push({ role: "assistant", text: answer });
    const suggestion = answer.match(/QUEST:\s*(.+?)\s*\|\s*(\d+)\s*\|\s*(Santé|Études|Projets|Bien-être)/i);
    await persist();
  } catch (error) {
    console.error("Erreur de conversation Gemini :", error);
    state.messages.push({ role: "assistant", text: `Impossible de contacter Gemini : ${error.message}` });
    await persist();
  }
  render();
}

function acceptQuestFromAI() {
  const button = view.querySelector("[data-action=accept-ai-quest]");
  const name = button?.dataset.name;
  const xp = Number(button?.dataset.xp);
  const domain = button?.dataset.domain;
  if (!name || !xp || !domain) return;
  state.quests.push({ id: uid(), name, xp, domain, period: "daily", done: false });
  state.messages.push({ role: "assistant", text: `Quête ajoutée : ${name} (+${xp} XP). Tu la retrouveras dans l'onglet Quêtes.` });
  updateTodayLog();
  persist();
  render();
  showToast("Quête proposée ajoutée !");
}

function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "navigate") {
    activeTab = button.dataset.tab;
    render();
  } else if (action === "toggle-quest") {
    const quest = state.quests.find(item => item.id === id);
    if (!quest) return;
    quest.done = !quest.done;
    quest.completedOn = quest.done ? todayKey() : null;
    updateTodayLog();
    persist();
    render();
  } else if (action === "delete-quest") {
    state.quests = state.quests.filter(item => item.id !== id);
    updateTodayLog();
    persist();
    render();
  } else if (action === "new-quest") showToast("Demande une qu&ecirc;te &agrave; l&rsquo;assistant IA.");
  else if (action === "add-visual") openModal("Add a visualization", `<div class="btn-row"><button type="button" class="btn" data-action="visualization-choice" data-kind="evolution">Evolution chart</button><button type="button" class="btn" data-action="visualization-choice" data-kind="calendar">Calendar</button></div>`);
  else if (action === "visualization-choice") { state.visualization=button.dataset.kind; persist(); modal.close(); render(); }
  else if (action === "remove-visual") { delete state.visualization; persist(); render(); }
  else if (action === "api-settings") openApiSettings();
  else if (action === "install") openInstallHelp();
  else if (action === "confirm-install" && installPrompt) {
    installPrompt.prompt();
    installPrompt.userChoice.then(result => {
      if (result.outcome === "accepted") showToast("Life RPG a été ajoutée à ton écran d'accueil.");
      installPrompt = null;
      modal.close();
    }).catch(error => {
      console.error("Échec du dialogue d'installation :", error);
      showToast("Chrome n'a pas pu démarrer l'installation.");
    });
  } else if (action === "export") exportData();
  else if (action === "import") document.querySelector("#import-file")?.click();
  else if (action === "send-chat") sendChat(document.querySelector("#chat-input")?.value || "");
  else if (action === "shortcut") sendChat(button.dataset.prompt || "");
  else if (action === "accept-ai-quest") acceptQuestFromAI();
  else if (action === "close-modal") modal.close();
}

document.querySelector("#view").addEventListener("scroll", event => {
  const card=event.currentTarget.querySelector(".stats-radar");
  if(card) card.style.setProperty("--radar-scale", String(1-Math.min(.16,event.currentTarget.scrollTop/900)));
}, {passive:true});
document.querySelector(".bottom-nav").addEventListener("click", event => {
  const button = event.target.closest(".nav-button");
  if (!button) return;
  activeTab = button.dataset.tab;
  render();
});
document.querySelector("#quick-button").addEventListener("click", openQuickUpdate);
document.querySelector("#rank-button").addEventListener("click", () => openModal("Les rangs Life RPG", `<p class="hint">16 paliers : Bois → Pierre → Marbre → Fer → Cuivre → Argent → Or → Platine → Diamant → Émeraude → Saphir → Rubis → Génie → Champion → Légende → Ultime.</p><p class="hint">Chaque rang comprend Novice, Avancé, Expert et Maître. Les seuils XP de cette première version sont indicatifs et modifiables au fil du projet. Les pénalités de decay et le gel hebdomadaire automatisé ne sont pas encore activés.</p>`));
document.querySelector("#modal").addEventListener("click", event => {
  if (event.target === modal) modal.close();
  if (event.target.closest("[data-action]")) handleAction(event.target.closest("[data-action]"));
});
document.querySelector("#modal-content").addEventListener("submit", event => {
  event.preventDefault();
  const formType = modalContent.dataset.form;
  if (formType === "quick") saveQuick(event.currentTarget);
  if (formType === "quest") saveQuest(event.currentTarget);
  if (formType === "api") saveApiSettings(event.currentTarget);
});
document.querySelector("#view").addEventListener("click", event => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  handleAction(button);
});
document.querySelector("#view").addEventListener("input", event => {
  if (event.target.id === "hero-name") {
    state.hero = event.target.value.slice(0, 24);
    persist();
    renderTopbar();
  } else if (event.target.id === "accent-color") {
    state.accent = event.target.value;
    renderTopbar();
  } else if (event.target.id === "radius-range") {
    state.radius = Number(event.target.value);
    document.documentElement.style.setProperty("--radius", `${state.radius}px`);
    document.querySelector("#radius-value").textContent = `${state.radius}px`;
  } else if (event.target.id === "chat-file") {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/") && file.type !== "application/pdf") {
      showToast("Choisis une image ou un PDF.");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      showToast("La pièce jointe doit faire moins de 15 Mo.");
      return;
    }
    pendingAttachment = file;
    document.querySelector("#attachment-label").textContent = `📎 ${file.name} · prêt à envoyer`;
  }
});
document.querySelector("#view").addEventListener("change", event => {
  if (event.target.id === "hero-name") {
    state.hero = event.target.value.trim() || "Héros";
    persist();
    render();
  } else if (event.target.id === "accent-color") {
    state.accent = event.target.value;
    persist();
    render();
  } else if (event.target.id === "radius-range") {
    state.radius = Number(event.target.value);
    persist();
    render();
  } else if (event.target.id === "import-file") {
    const file = event.target.files?.[0];
    if (file) importData(file);
    event.target.value = "";
  }
});
document.querySelector("#view").addEventListener("keydown", event => {
  if (event.target.id === "chat-input" && event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChat(event.target.value);
  }
});
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null;
  showToast("Life RPG est installée !");
});
window.addEventListener("online", () => showToast("Connexion Internet rétablie."));
window.addEventListener("offline", () => showToast("Hors ligne : tes données et quêtes restent disponibles."));

async function start() {
  state = await loadState();
  state = { ...initialState(), ...state, apiKey: state.apiKey || "" };
  state.quests = Array.isArray(state.quests) ? state.quests : initialState().quests;
  state.logs = state.logs && typeof state.logs === "object" ? state.logs : {};
  state.messages = Array.isArray(state.messages) ? state.messages.slice(-40) : [];
  rollDayIfNeeded();
  updateTodayLog();
  await persist();
  render();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.error("Enregistrement hors-ligne impossible :", error);
      showToast("Le mode hors ligne n'a pas pu être activé.");
    });
  }
}

start().catch(error => {
  console.error("Démarrage de Life RPG impossible :", error);
  document.querySelector("#view").innerHTML = `<section class="card"><h1>Erreur de démarrage</h1><p class="hint">${escapeHtml(error.message)}</p><button class="btn" onclick="location.reload()">Réessayer</button></section>`;
});
