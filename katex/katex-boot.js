(function () {
  'use strict';
  if (!window.renderMathInElement || !window.katex) return;
  const options = {
    delimiters: [
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
      { left: "$$", right: "$$", display: true }
    ],
    throwOnError: false,
    strict: "ignore",
    ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"]
  };
  const render = (node) => {
    if (!node || node.nodeType !== 1 || node.closest?.('.katex')) return;
    try { window.renderMathInElement(node, options); }
    catch (error) { console.warn('KaTeX render:', error); }
  };
  const start = () => {
    render(document.body);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (target && !target.closest?.('.katex')) render(target);
        for (const added of record.addedNodes) {
          if (added.nodeType === 1 && !added.classList?.contains('katex')) render(added);
        }
      }
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();