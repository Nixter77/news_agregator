export function bindImageFallback(root) {
  if (!root) return;
  const images = root.tagName === 'IMG' ? [root] : root.querySelectorAll('img');
  images.forEach((img) => {
    if (img.dataset.fallbackBound === '1') return;
    img.dataset.fallbackBound = '1';
    img.addEventListener('error', () => {
      const card = img.closest('.news-card');
      const favorite = img.closest('.favorite-item');
      img.remove();
      if (card) card.classList.add('news-card--no-media');
      if (favorite) favorite.classList.add('favorite-item--no-media');
    });
  });
}
