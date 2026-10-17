/* ============ support-ui.js — "Apoyar al autor original" ============
 * Botón con un corazón en la barra del menú (sólo si hay cuenta de Ko-fi en
 * js/data/funding.js). Versión no oficial: la ventana deja claro que las
 * donaciones van al autor original (JPTER78), no a esta versión.
 */
G.SupportUI = (() => {
  const $ = G.UI.$;
  const F = G.Funding;

  function init() {
    const b = $('btn-support');
    if (!F.url) return;                       // aún sin cuenta de Ko-fi: no sale
    b.classList.remove('hidden');
    b.innerHTML = G.Icons.html('heart', 18) + ' <span>Apoyar</span>';
    b.onclick = open;
    $('sup-close').onclick = close;
  }

  // Versión no oficial: no recoge dinero. El botón lleva a apoyar al AUTOR ORIGINAL.
  function open() {
    const sp = F.sponsors ? 'https://github.com/sponsors/' + F.sponsors : '';
    $('sup-body').innerHTML = `
      <p class="fork-note">Esta es una versión no oficial: no acepta donaciones ni pagos.</p>
      <p>PokéSurvivor es obra de JPTER78. Si quieres apoyar el juego, puedes hacer una donación voluntaria a su autor original. Ese dinero va al autor original, no a esta versión.</p>
      <p class="sub">Donar no da ninguna ventaja en el juego.</p>
      <div class="row wrap" style="gap:8px;justify-content:center;margin-top:10px">
        <a class="btn gold" href="${F.url}" target="_blank" rel="noopener">${G.Icons.html('heart', 18)} Donar en Ko-fi</a>
        ${sp ? `<a class="btn" href="${sp}" target="_blank" rel="noopener">GitHub Sponsors</a>` : ''}
      </div>`;
    $('scr-support').classList.remove('hidden');
  }

  function close() { $('scr-support').classList.add('hidden'); }

  return { init, open, close };
})();
