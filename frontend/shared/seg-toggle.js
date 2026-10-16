// shared/seg-toggle.js
//
// The sliding segmented toggle used on the Team page (Active / Removed), made reusable for the
// Platform Admin queues (Vendor Verification, Company Verification, Fraud Review Queue). It uses the
// SAME classes (.seg-toggle / .seg-thumb / .seg-btn / .seg-count) and the same timings as Team, so the
// look, the sliding thumb and the table swap (fade out -> height glide -> rows rise in) are identical.
//
//   const toggle = createViewToggle({
//     mountId: 'viewToggle',          // empty element the toggle is built into
//     wrapId:  'viewWrap',            // wrapper around the table (animates its own height)
//     tableId: 'viewTable',           // the table (fades / rows rise in)
//     views:   [{ key: 'pending', label: 'Pending' }, ...],
//     initial: 'pending',
//     onSwap:  () => { lastHtml = null; render(); }   // re-render the rows for the NEW view
//   });
//   toggle.setCounts({ pending: 3, verified: 5 });     // numbers shown on the buttons
//   toggle.getView();                                  // current view key
//   toggle.isSwapping();                               // true during the fade-out: don't write rows then
//
// Nothing here talks to the server; the page keeps its own polling and just asks getView().
function createViewToggle({ mountId, wrapId, tableId, views, initial, onSwap }) {
  const mount = document.getElementById(mountId);
  const wrap = document.getElementById(wrapId);
  const table = document.getElementById(tableId);
  let view = initial || views[0].key;
  let swapTimer = null;
  let swapPending = false; // true during the fade-out, so a poll tick can't swap rows mid-fade
  let cleanupTimer = null;

  mount.classList.add('seg-toggle');
  mount.innerHTML = '<span class="seg-thumb"></span>' + views.map(v =>
    `<button type="button" class="seg-btn" data-view="${v.key}">${v.label} <span class="seg-count">0</span></button>`
  ).join('');
  const thumb = mount.querySelector('.seg-thumb');
  const btns = {};
  mount.querySelectorAll('.seg-btn').forEach(b => { btns[b.dataset.view] = b; b.addEventListener('click', () => setView(b.dataset.view)); });

  // Moves the sliding thumb under the active option. Measured from the real button (its width
  // changes with the count digits), so it always fits exactly.
  function updateToggle() {
    const btn = btns[view];
    Object.keys(btns).forEach(k => btns[k].classList.toggle('active', k === view));
    thumb.style.width = btn.offsetWidth + 'px';
    thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
    // First placement must not animate in from x=0, so only enable the slide after it.
    if (!thumb.classList.contains('ready')) requestAnimationFrame(() => thumb.classList.add('ready'));
  }
  window.addEventListener('resize', updateToggle);

  function setView(next) {
    if (next === view || !btns[next]) return;
    const startH = wrap.offsetHeight;
    wrap.style.height = startH + 'px'; // pin the current height so it can animate
    view = next;
    updateToggle();                    // the thumb starts gliding immediately...
    clearTimeout(cleanupTimer);
    table.classList.remove('view-swap-in');
    table.classList.add('view-swap-out'); // ...while the whole table (header too) fades out,
    clearTimeout(swapTimer);
    swapPending = true;
    swapTimer = setTimeout(() => {
      swapPending = false;
      if (onSwap) onSwap();            // swap content while invisible,
      wrap.style.height = 'auto';
      const endH = wrap.offsetHeight;  // measure the new natural height,
      wrap.style.height = startH + 'px';
      void wrap.offsetHeight;          // (force reflow so the change below animates)
      wrap.style.height = endH + 'px'; // glide the page content to its new position,
      table.classList.remove('view-swap-out');
      table.classList.add('view-swap-in'); // and let the new rows rise in.
      cleanupTimer = setTimeout(() => { wrap.style.height = ''; table.classList.remove('view-swap-in'); }, 800);
    }, 280);
  }

  function setCounts(counts) {
    views.forEach(v => { btns[v.key].querySelector('.seg-count').textContent = counts[v.key] || 0; });
    updateToggle();
  }

  updateToggle();
  return { setCounts, getView: () => view, isSwapping: () => swapPending, updateToggle };
}
