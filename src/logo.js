/**
 * The mark: a ramble settling into a line — a wave that calms down into flat,
 * readable text, on WhatsApp green. LOGO_SVG is the one-wave cut that stays
 * legible at nav and favicon sizes; docs/logo.svg is the full four-wave mark.
 */
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Logo">
<rect width="64" height="64" rx="18" fill="#25d366"/>
<path d="M8 32q5.5-26 11 0q5.5 22 11 0h26" fill="none" stroke="#121212" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// The full four-wave mark, for places with room: the control group's icon.
export const LOGO_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${'Ramble'}">
<rect width="64" height="64" rx="18" fill="#25d366"/>
<path d="M8 32q4.5-24 9 0q4.5 20 9 0q3.5-13 7 0q3.5 8 7 0h16" fill="none" stroke="#121212" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const LOGO_DATA_URI = `data:image/svg+xml,${encodeURIComponent(LOGO_SVG)}`;
