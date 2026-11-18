# POS runtime source

`pos.js` is maintained as ordered source fragments in this directory. `scripts/copy-legacy.mjs` joins the numbered files in lexical order and writes the generated classic script to `public/pos.js` and `public/legacy/pos.js` before dev/build.

The fragments intentionally share the original IIFE scope and must remain in order. They are split by behavior area to keep source files reviewable; they are not standalone ES modules. The generated browser script currently remains a single script because tab handlers share state and are initialized against the full POS document.

| File | Area |
| --- | --- |
| `01-runtime-state.js` | State and startup |
| `02-sync-conflicts.js` | Sync events and conflict handling |
| `03-cashier-cart.js` | Cart and cashier flow |
| `04-sales-receipts.js` | Checkout and receipts |
| `05-shift-cash.js` | Shifts and cash movements |
| `06-shift-roles.js` | Shift rendering and role UI |
| `07-inventory-products.js` | Inventory and product editing |
| `08-receivables-auth.js` | Receivables and credentials |
| `09-users-outlets.js` | Users and outlets |
| `10-stock-adjustments.js` | Sale stock restoration |
| `11-product-import-export.js` | Product file import/export |
| `12-page-bindings.js` | POS event bindings and permissions |
| `13-attendance.js` | Attendance |
| `14-discount-approvals.js` | Discount approval flow |
| `15-reports-charts.js` | Report controls and charts |
