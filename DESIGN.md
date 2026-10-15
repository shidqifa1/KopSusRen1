# Baristack App Design Direction

Status: documented from the established Baristack interface and approved through Anti-Slop audit finding 11.

## Product and audience

Baristack App is a compact operational workspace for the owner of a small beverage business. The interface prioritizes fast daily actions on a phone: opening PO, reviewing orders, confirming payment, checking stock, recording expenses, and exporting data.

## Identity

The product should feel warm, grounded, practical, and familiar. It should resemble a well-organized coffee counter rather than a generic technology dashboard.

## Visual decisions and reasons

- Warm cream canvas: reduces glare and supports the coffee-shop identity.
- Deep brown structure: gives navigation and headings a stable, grounded hierarchy.
- Green primary actions: communicates safe progress, paid status, and available stock without relying on decoration.
- Dark orange warning state: separates attention states from destructive red while preserving accessible contrast.
- DM Serif Display for product identity and major headings: adds a recognisable café character.
- Plus Jakarta Sans for controls and operational data: keeps compact mobile content readable.
- Compact cards: group one operational decision at a time without turning the screen into a decorative card mosaic.
- Drawer navigation: keeps many owner tools reachable on a phone while leaving the current task dominant.
- Text-first controls: labels carry meaning; decorative emoji are not part of the interface icon system.
- Limited motion: short transitions confirm state changes without slowing repeated daily actions.

## Layout and interaction

- Mobile is the primary working surface.
- Interactive targets are at least 44 by 44 pixels.
- Navigation, tabs, forms, cards, and dialogs must be fully keyboard operable.
- Every data view provides useful loading, empty, and error feedback.
- Empty states explain what is missing and the next action that creates data.
- Operational status must use text in addition to color.
- The application behind authentication must not be exposed to the accessibility tree before login.

## Design dials

- ENERGY 1: calm and task-focused.
- RHYTHM 1: consistent and predictable for repeated operations.
- MOTION 1: restrained, with motion used only for feedback and navigation state.

## Boundaries

- Do not introduce decorative emoji, generic AI icons, neon colors, glass-heavy surfaces, or ornamental gradients.
- Do not add a new visual asset without owner approval.
- Do not trade readability or tap accuracy for density.
- Do not create a separate visual language for WhatsApp features; they belong to the same Baristack operational system.
