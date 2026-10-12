// Line icons (24px grid, 1.6 stroke) so the look doesn't depend on the visitor's emoji font.
const P: Record<string, string> = {
  coffin: '<path d="M9 2.5h6l3 5-2 14H8L6 7.5z"/><path d="M12 8v6M9.5 10.5h5"/>',
  ghost: '<path d="M5 21V10a7 7 0 0 1 14 0v11l-2.3-1.6L14.3 21 12 19.4 9.7 21l-2.4-1.6z"/><circle cx="9.5" cy="10.5" r="1" fill="currentColor"/><circle cx="14.5" cy="10.5" r="1" fill="currentColor"/>',
  scale: '<path d="M12 3v18M6 21h12M5 7h14"/><path d="M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z"/>',
  mask: '<path d="M3 8c3-2 15-2 18 0 0 6-3 10-9 10S3 14 3 8z"/><path d="M7 11.5c1-.8 2.4-.8 3.2 0M13.8 11.5c.8-.8 2.2-.8 3.2 0"/>',
  letter: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/><circle cx="12" cy="16" r="1.6"/>',
  key: '<circle cx="7.5" cy="12" r="4"/><path d="M11.5 12H21M18 12v3M15.5 12v2"/>',
  candle: '<path d="M9 21h6V10H9z"/><path d="M12 10V7"/><path d="M12 2.5c1.6 1.8 1.8 3.2 0 4.5-1.8-1.3-1.6-2.7 0-4.5z" fill="currentColor"/><path d="M7 21h10"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9"/>',
  back: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  urn: '<path d="M8 3h8M9 3v3c-3 1-4 4-4 7 0 4 3 8 7 8s7-4 7-8c0-3-1-6-4-7V3"/><path d="M6 12h12"/>',
  flask: '<path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7.5 15h9"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
export const icon = (name: keyof typeof P, size = 20) =>
  `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;
