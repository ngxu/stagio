// 中文 / English, one at a time. The choice is kept in this browser; the first visit follows the
// browser's language. The download page switches in place; the guide is one page per language
// (<html data-only="en" data-other="zh.html">) and switching goes to the other page.
(function () {
  var KEY = 'stagio.lang';
  var root = document.documentElement;
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: not kept */ } }
  var pref = stored();
  var lang = pref || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  var only = root.getAttribute('data-only');
  var other = root.getAttribute('data-other');
  // A one-language page sends the reader to the other one when they chose that language, or on a
  // first visit to the default (English) page from a Chinese browser. A shared link to the Chinese
  // page stays Chinese for someone who hasn't chosen.
  if (only && other && only !== lang && (pref || only === 'en')) { location.replace(other + location.hash); return; }

  function apply(l) {
    lang = l;
    root.classList.remove('lang-zh', 'lang-en');
    root.classList.add('lang-' + l);
    root.lang = l === 'zh' ? 'zh-Hans' : 'en';
    var btns = document.querySelectorAll('[data-lang-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].textContent = l === 'zh' ? 'English' : '中文';
      btns[i].setAttribute('aria-label', l === 'zh' ? 'Switch to English' : '切换到中文');
    }
    var links = document.querySelectorAll('[data-guide]');
    for (var j = 0; j < links.length; j++) links[j].setAttribute('href', links[j].getAttribute('data-guide') + (l === 'zh' ? 'zh.html' : ''));
  }
  apply(only || lang);
  document.addEventListener('DOMContentLoaded', function () {
    apply(only || lang);
    var btns = document.querySelectorAll('[data-lang-toggle]');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var next = lang === 'zh' ? 'en' : 'zh';
        save(next);
        if (only && other) location.href = other + location.hash; else apply(next);
      });
    }
  });
})();
