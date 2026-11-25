# Stylesheet sources

- `shell/` contains shared application shell and landing page styles. The owner dashboard styles live beside its React component in `app/src/pages/`.
- `design-system.css` is the Tailwind input for `app/pos/index.html`; the generated stylesheet is written to `public/pos.css`.
- `shared/pos-fonts.css` is copied to `public/pos-fonts.css` and shares the local font files with the POS page.

The build preserves the established public stylesheet URLs while keeping source files organized by purpose.

## Status and metadata

- Do not use decorative status dots, including pulsing or ringed dots.
- Do not separate text with a middle dot; use commas, hyphens, or separate lines.
- Do not use pill-shaped badges or number badges. Write status and counts as plain text.
- Do not embed third-party badge images in project documentation.

Run `npm run check:style` to check these rules. The production build runs the
same check before compiling assets.
