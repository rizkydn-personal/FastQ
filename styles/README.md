# Stylesheet sources

- `shell/` contains shared application shell and landing page styles. The owner dashboard styles live beside its React component in `app/src/pages/`.
- `design-system.css` is the Tailwind input for `app/pos/index.html`; the generated stylesheet is written to `public/pos.css`.
- `shared/pos-fonts.css` is copied to `public/pos-fonts.css` and shares the local font files with the POS page.

The build preserves the established public stylesheet URLs while keeping source files organized by purpose.
