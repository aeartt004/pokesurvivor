/* ============ cheats-ui.js — menú de trucos para probar el juego ============
 * Se abre con F8 (PC) o con el botón "Trucos" de Ajustes (también en móvil,
 * desde la pausa > Ajustes). Sólo funciona en MODO LOCAL: si la partida está
 * en la nube (Firebase) o en cooperativo, no se abre, para no subir datos
 * trucados a ningún servidor.
 *
 * Todo pasa por las funciones normales del juego (G.DB.commit, G.DB.grant,
 * G.Progress, G.Game.debug*...), no se toca localStorage a mano.
 * Las partidas con trucos de partida no cuentan para el ranking (G.Game.clean).
 */
G.Cheats = (() => {
  const $ = G.UI.$;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let god = false;
  let resumeOnClose = false;     // se abrió con F8 en plena partida: al cerrar, sigue

  /** Por qué no se puede usar ahora (o '' si se puede). */
  function blockedReason() {
    if (G.DB.mode === 'cloud' || G.DB.online) return 'Los trucos sólo funcionan en modo local (sin Firebase).';
    if (G.Coop && G.Coop.active) return 'Los trucos no funcionan en cooperativo.';
    if (!G.DB.save) return 'Inicia sesión primero.';
    return '';
  }

  const inRun = () => !!G.Game.player && G.Game.state !== 'ui' && G.Game.state !== 'over';
  const isOpen = () => !$('scr-cheats').classList.contains('hidden');

  function open() {
    const why = blockedReason();
    if (why) { G.UI.toast(why, 3500); return; }
    resumeOnClose = false;
    if (G.Game.state === 'playing') { G.Game.togglePause(); resumeOnClose = G.Game.state === 'paused'; }
    $('scr-cheats').classList.remove('hidden');
    render();
  }

  function close() {
    $('scr-cheats').classList.add('hidden');
    if (resumeOnClose && G.Game.state === 'paused' && !G.SettingsUI.isOpen) G.Game.togglePause();
    resumeOnClose = false;
    if (!$('topbar').classList.contains('hidden')) G.UI.refreshCoins();
  }

  function toggle() { if (isOpen()) close(); else open(); }

  // ---------------- acciones ----------------

  function saved(msg) {
    G.DB.commit(true);
    if (!$('topbar').classList.contains('hidden')) G.UI.refreshCoins();
    if (msg) G.UI.toast(msg);
    render();
  }

  const clampN = v => Math.max(0, Math.floor(Number(v) || 0));

  function addCur(kind, n) {
    const s = G.DB.save;
    s.tickets = s.tickets || { t1: 0, t10: 0 };
    if (kind === 'c') s.coins = clampN(s.coins + n);
    else s.tickets[kind] = clampN(s.tickets[kind] + n);
    saved();
  }

  function setCur(kind, n) {
    const s = G.DB.save;
    s.tickets = s.tickets || { t1: 0, t10: 0 };
    if (kind === 'c') s.coins = clampN(n);
    else s.tickets[kind] = clampN(n);
    saved();
  }

  const playable = () => G.DEX.filter(p => G.SPRITE_META[p.dex]);

  function giveMon(p, shiny) {
    if (!shiny) { const had = G.DB.owns(p.dex); G.DB.grant(p.dex, 'gacha'); return !had; }
    const isNew = G.DB.grantShiny(p.dex, 'gacha');
    if (isNew) G.DB.save.stats.shinies = (G.DB.save.stats.shinies || 0) + 1;
    return isNew;
  }

  function unlockAll(shiny) {
    let n = 0;
    for (const p of playable()) if (giveMon(p, shiny)) n++;
    G.Progress.checkAch();
    saved((shiny ? 'Shinies nuevos: ' : 'Pokémon nuevos: ') + n);
  }

  function findMon(q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return null;
    const list = playable();
    if (/^#?\d+$/.test(q)) return list.find(p => p.dex === +q.replace('#', '')) || null;
    const name = p => [p.name.toLowerCase(), String(G.T(p.name)).toLowerCase()];
    return list.find(p => name(p).includes(q)) || list.find(p => name(p).some(n => n.startsWith(q))) || list.find(p => name(p).some(n => n.includes(q))) || null;
  }

  function giveOne(shiny) {
    const p = findMon($('cht-mon').value);
    if (!p) { G.UI.toast('No se encuentra ese Pokémon'); return; }
    giveMon(p, shiny);
    G.Progress.checkAch();
    saved((shiny ? 'Shiny conseguido: ' : 'Pokémon conseguido: ') + G.T(p.name));
  }

  function maxUpgrades() {
    const s = G.DB.save;
    if (!s.partner) { G.UI.toast('Primero elige un compañero'); return; }
    const u = G.DB.upgradesOf(s.partner);
    for (const d of G.Upgrades.LIST) u[d.id] = d.max;
    saved('Mejoras al máximo: ' + G.T(G.DEX_BY[s.partner].name));
  }

  function pityMax() {
    const s = G.DB.save;
    s.pity = s.pity || {};
    for (const b of G.Gacha.BANNERS) s.pity[b.gen] = G.Gacha.PITY_5 - 1;
    saved('La próxima tirada de cada banner sale ★5');
  }

  function missionsDone() {
    const s = G.DB.save;
    G.Progress.ensure(s);
    let n = 0;
    for (const m of [...s.missions.daily, ...s.missions.weekly]) {
      if (m.claimed || m.prog >= m.goal) continue;
      m.prog = m.goal; m.told = true; n++;
    }
    saved('Misiones completadas: ' + n + ' (recoge los premios en Misiones)');
  }

  function allAch() {
    const s = G.DB.save;
    s.ach = s.ach || {};
    let n = 0;
    for (const a of G.AchDefs.LIST) {
      if (s.ach[a.id]) continue;
      s.ach[a.id] = Date.now();
      G.Progress.grant(a.reward);
      n++;
    }
    saved('Logros conseguidos: ' + n);
  }

  // --- en la partida ---
  function runAct(fn, msg) {
    if (!inRun()) return;
    G.Game.debugTamper();
    fn(G.Game.player);
    if (msg) G.UI.toast(msg);
    render();
  }

  function killAll() {
    for (const e of G.EnemyMgr.all()) if (!e.dead && !e.remote) e.hurt(1e9, '#ffffff');
  }

  function skip(sec) { G.Game.debugTime(G.Game.st.time + sec); }

  // ---------------- pantalla ----------------

  const btn = (act, label, cls = '') => `<button class="btn small ${cls}" data-act="${act}">${esc(label)}</button>`;
  const row = (title, desc, right) => `<div class="set-row cht-row"><div class="grow"><b>${esc(title)}</b>${desc ? `<small>${esc(desc)}</small>` : ''}</div><div class="cht-btns">${right}</div></div>`;
  const h = t => `<h3 class="set-h">${esc(t)}</h3>`;

  function render() {
    if (!isOpen()) return;
    const s = G.DB.save;
    if (!s) { close(); return; }
    const t = s.tickets || { t1: 0, t10: 0 };
    const box = $('cht-body');
    const keep = box.scrollTop;
    const monQ = $('cht-mon') ? $('cht-mon').value : '';
    const head = `<p class="sub">Sólo para pruebas. Los cambios se guardan en este navegador${G.DB.guest ? ' (como invitado no se guarda nada)' : ''}.</p>`
      + `<p class="cht-bal"><span class="coin"></span> <b>${s.coins.toLocaleString('es')}</b> &nbsp; ${G.Icons.html('ticket', 16)} <b>${t.t1}</b> &nbsp; ${G.Icons.html('ticket10', 16)} <b>${t.t10}</b></p>`;
    const meta = h('Monedas y tickets')
      + row('Pokémonedas', '', btn('c:1000', '+1.000') + btn('c:10000', '+10.000') + btn('c:100000', '+100.000', 'gold'))
      + row('Tickets ×1', '', btn('t1:1', '+1') + btn('t1:10', '+10') + btn('t1:100', '+100', 'gold'))
      + row('Tickets ×10', '', btn('t10:1', '+1') + btn('t10:10', '+10') + btn('t10:100', '+100', 'gold'))
      + row('Cantidad exacta', 'Escribe un número y elige a qué ponerlo.',
            `<input id="cht-num" class="field cht-field" type="number" min="0" step="1" inputmode="numeric" value="0">`
            + btn('set:c', 'Monedas') + btn('set:t1', 'Tickets ×1') + btn('set:t10', 'Tickets ×10'))
      + h('Colección y gacha')
      + row('Todos los Pokémon', 'Desbloquea todos los Pokémon del juego.', btn('allMon', 'Desbloquear'))
      + row('Todos los shinies', 'Desbloquea la versión shiny de todos.', btn('allShiny', 'Desbloquear'))
      + row('Dar un Pokémon', 'Número de la Pokédex o nombre.',
            `<input id="cht-mon" class="field cht-field wide" type="text" spellcheck="false" autocomplete="off" placeholder="Número o nombre" value="${esc(monQ)}">`
            + btn('giveMon', 'Dar') + btn('giveShiny', 'Dar shiny'))
      + row('Mejoras del compañero al máximo', 'Todas las mejoras de tu Pokémon actual al nivel máximo.', btn('maxUpg', 'Aplicar'))
      + row('★5 garantizado', 'La próxima tirada de cada banner del gacha sale ★5.', btn('pity', 'Aplicar'))
      + row('Próxima tirada shiny', 'El próximo Pokémon que salga en el gacha será shiny.', btn('gachaShiny', 'Aplicar'))
      + h('Misiones y logros')
      + row('Completar misiones', 'Las de hoy y las de la semana quedan listas para recoger el premio.', btn('missions', 'Completar'))
      + row('Todos los logros', 'Consigue todos los logros con sus premios.', btn('ach', 'Conseguir'));
    // En partida, lo de la partida va primero (es lo que más se usa ahí).
    let run = h('En la partida')
      + `<div class="set-row cht-row"><div class="grow"><b>Invencible</b><small>No recibes daño (también en las próximas partidas, hasta que lo quites).</small></div>
           <button class="btn small switch ${god ? 'gold' : ''}" data-act="god">${god ? 'Sí' : 'No'}</button></div>`;
    if (inRun()) {
      const k = G.Game.speed;
      run += row('Curar', 'Recupera toda la vida.', btn('heal', 'Curar'))
        + row('Subir de nivel', 'Al seguir jugando salen las cartas de cada nivel.', btn('lv1', '+1 nivel') + btn('lv5', '+5 niveles'))
        + row('Derrotar a todos los enemigos', '', btn('kill', 'Derrotar'))
        + row('Hacer aparecer un jefe', '', btn('boss', 'Aparecer'))
        + row('Grieta', 'Abre una grieta cerca o entra directo en la arena del legendario.', btn('rift', 'Abrir grieta') + btn('arena', 'Ir a la arena'))
        + row('Saltar tiempo', 'Adelanta el reloj de la partida.', btn('skip60', '+1 min') + btn('skip300', '+5 min'))
        + row('Sentencia de Arceus', 'Empieza ya el combate final.', btn('judge', 'Empezar'))
        + row('Próximo shiny salvaje', 'El próximo Pokémon salvaje que aparezca será shiny.', btn('wildShiny', 'Aplicar'))
        + row('Velocidad del juego', '', [0.5, 1, 2, 3].map(v => `<button class="chip ${k === v ? 'on' : ''}" data-act="speed:${v}">×${String(v).replace('.', ',')}</button>`).join(''));
    } else {
      run += `<p class="sub cht-note">Empieza una partida y abre los trucos desde la pausa (Ajustes > Trucos) o con F8 para ver más opciones: curar, subir de nivel, jefes, grietas, saltar tiempo...</p>`;
    }
    box.innerHTML = head + (inRun() ? run + meta : meta + run);
    box.scrollTop = keep;
    box.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => act(b.dataset.act); });
  }

  function act(a) {
    const why = blockedReason();
    if (why) { G.UI.toast(why, 3500); close(); return; }
    const [k, v] = a.split(':');
    if (k === 'c' || k === 't1' || k === 't10') return addCur(k, +v);
    if (k === 'set') return setCur(v, $('cht-num').value);
    switch (k) {
      case 'allMon': return unlockAll(false);
      case 'allShiny': return unlockAll(true);
      case 'giveMon': return giveOne(false);
      case 'giveShiny': return giveOne(true);
      case 'maxUpg': return maxUpgrades();
      case 'pity': return pityMax();
      case 'gachaShiny': G.Gacha.debugForceShiny(1); G.UI.toast('La próxima tirada sale shiny'); return;
      case 'missions': return missionsDone();
      case 'ach': return allAch();
      case 'god':
        god = !god;
        if (god && inRun()) G.Game.debugTamper();
        G.UI.toast(god ? 'Invencible: activado' : 'Invencible: desactivado');
        return render();
      case 'heal': return runAct(p => { p.hp = p.maxHp; }, 'Vida al máximo');
      case 'lv1': return runAct(() => G.Game.debugLevelUp(), '+1 nivel');
      case 'lv5': return runAct(() => { for (let i = 0; i < 5; i++) G.Game.debugLevelUp(); }, '+5 niveles');
      case 'kill': return runAct(killAll, 'Enemigos derrotados');
      case 'boss': return runAct(() => G.Spawner.debugBoss(), '¡Ha aparecido un jefe!');
      case 'rift':
        if (G.Rift.inArena || G.Rift.rift) { G.UI.toast('Ya hay una grieta abierta'); return; }
        return runAct(() => G.Rift.debugOpen(), 'Grieta abierta cerca');
      case 'arena':
        if (G.Rift.inArena || G.Judgment.active) { G.UI.toast('Ahora no se puede'); return; }
        return runAct(() => G.Rift.debugArena(), 'Arena del legendario');
      case 'skip60': return runAct(() => skip(60), '+1 min');
      case 'skip300': return runAct(() => skip(300), '+5 min');
      case 'judge':
        if (G.Judgment.active || G.Rift.inArena) { G.UI.toast('Ahora no se puede'); return; }
        return runAct(() => G.Judgment.debugStart(), 'Sentencia de Arceus');
      case 'wildShiny': return runAct(() => G.Spawner.debugForceShiny(1), 'El próximo salvaje sale shiny');
      case 'speed': return runAct(() => G.Game.debugSpeed(+v), 'Velocidad ×' + String(v).replace('.', ','));
    }
  }

  function init() {
    $('cht-close').onclick = close;
    $('set-cheats').onclick = open;
    // Lo que se escribe en los campos no llega al juego (la P no quita la pausa...).
    $('scr-cheats').addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    // F8 abre/cierra los trucos; Esc los cierra (antes que la pausa o los menús).
    addEventListener('keydown', e => {
      if (e.code === 'F8' || e.key === 'F8') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
      if (e.key === 'Escape' && isOpen()) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    }, true);
  }

  return {
    init, open, close, toggle,
    get isOpen() { return isOpen(); },
    /** Invencible (nunca en la nube ni en cooperativo). */
    get god() { return god && G.DB.mode !== 'cloud' && !(G.Coop && G.Coop.active); }
  };
})();
