const preference = matchMedia('(prefers-reduced-motion: reduce)');
const active = new Map();
const easing = 'cubic-bezier(0.22, 1, 0.36, 1)';

function settle(element) {
  const running = active.get(element);
  if (!running) return;
  active.delete(element);
  running.animation.cancel();
  running.finish();
}

function play(element, frames, finish = () => {}, duration = 260) {
  if (preference.matches || !element.isConnected || !element.animate) {
    finish();
    return;
  }
  const animation = element.animate(frames, { duration, easing });
  const running = { animation, finish };
  active.set(element, running);
  animation.finished.then(() => {
    if (active.get(element) !== running) return;
    active.delete(element);
    finish();
  }).catch(() => {
    if (active.get(element) !== running) return;
    active.delete(element);
    finish();
  });
}

export function enterView(element, direction = 1) {
  settle(element);
  play(element, [
    { opacity: 0.65, transform: direction ? `translateY(${direction * 8}px)` : 'none' },
    { opacity: 1, transform: direction ? 'translateY(0)' : 'none' }
  ], undefined, 220);
}

export function resizeContent(element, update) {
  const height = element.getBoundingClientRect().height;
  settle(element);
  update();
  const nextHeight = element.getBoundingClientRect().height;
  play(element, [
    { height: `${height}px`, overflow: 'clip' },
    { height: `${nextHeight}px`, overflow: 'clip' }
  ]);
}

export function disclose(element, expanded, render = () => {}, onExpanded = () => {}) {
  const height = element.getBoundingClientRect().height;
  settle(element);
  const nativeDetails = element.tagName === 'DETAILS';
  render();
  if (nativeDetails) element.open = true;
  else {
    element.hidden = false;
    element.inert = !expanded;
  }
  const nextHeight = expanded ? element.getBoundingClientRect().height : nativeDetails ? element.querySelector('summary').getBoundingClientRect().height : 0;
  const finish = () => {
    if (nativeDetails) {
      element.open = expanded;
      delete element.dataset.expanded;
    } else {
      element.hidden = !expanded;
      element.inert = !expanded;
    }
    if (expanded && element.isConnected) onExpanded();
  };
  if (nativeDetails) element.dataset.expanded = String(expanded);
  play(element, [
    { height: `${height}px`, overflow: 'clip' },
    { height: `${nextHeight}px`, overflow: 'clip' }
  ], finish);
}

export function bindDisclosures(root) {
  root.addEventListener('click', event => {
    const summary = event.target.closest('summary');
    const details = summary?.parentElement;
    if (!details?.matches('.functions-guide details, .report-details, .trophy-celebration details') || event.defaultPrevented) return;
    if (event.target.closest('a, button, input, select, textarea')) return;
    event.preventDefault();
    const expanded = details.dataset.expanded ? details.dataset.expanded === 'true' : details.open;
    disclose(details, !expanded);
  });
}

preference.addEventListener('change', () => {
  if (preference.matches) [...active.keys()].forEach(settle);
});