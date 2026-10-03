/* Öğrenci ve öğretmen sayfalarında ortak yardımcılar */
(function () {
  const SHAPES = [
    '<svg class="shape" viewBox="0 0 40 40"><polygon points="20,4 37,35 3,35" fill="#fff"/></svg>',
    '<svg class="shape" viewBox="0 0 40 40"><polygon points="20,3 37,20 20,37 3,20" fill="#fff"/></svg>',
    '<svg class="shape" viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="#fff"/></svg>',
    '<svg class="shape" viewBox="0 0 40 40"><rect x="5" y="5" width="30" height="30" fill="#fff"/></svg>',
  ];

  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60);
    return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : String(s);
  }

  let toastTimer;
  function toast(msg) {
    let t = $('.toast');
    if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  // Sunucunun gönderdiği "kalan süre" değerine göre yerel saatle geri sayım
  function countdown(remainingMs, onTick, onDone) {
    const end = Date.now() + remainingMs;
    let id;
    const tick = () => {
      const left = end - Date.now();
      onTick(Math.max(0, left));
      if (left <= 0) { clearInterval(id); if (onDone) onDone(); }
    };
    id = setInterval(tick, 200);
    tick();
    return () => clearInterval(id);
  }

  const REASONS = {
    completed: 'Tüm sorular tamamlandı.',
    teacher: 'Quiz öğretmen tarafından bitirildi.',
    time: 'Quiz süresi doldu.',
  };

  window.Q = { SHAPES, $, el, fmtTime, toast, countdown, REASONS };
})();
