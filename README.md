# SafetySpell Guardian

Build a polished, mobile-first theme for "SafetySpell" and make the app 

a fully installable PWA. This is a life-safety product for vulnerable 

people (elderly, disabled, deaf-mute, epilepsy, cardiac, etc.), so the 

design must be calm, extremely clear, and instantly readable by a scared 

stranger — not flashy.

=== PWA REQUIREMENTS (must-have) ===

- Full PWA: valid manifest.json (name "SafetySpell", short_name, theme 

  color, background color, display "standalone"), all icon sizes, 

  maskable icon, splash screen.

- Service worker so the app is installable ("Add to Home Screen") and 

  the app shell loads offline.

- App-like feel: no browser chrome once installed, bottom tab bar, 

  edge-to-edge layout, smooth transitions, skeleton loaders (not spinners).

- Works on Android (Chrome) and iOS (Safari) install flows.

=== TWO SURFACES, DIFFERENT DESIGN ===

1. SCAN WEB (public, no login): 

   - Opens in a plain browser, must load in ~1 second on a bad network.

   - Full-screen, ONE big primary action button (e.g. "CALL FAMILY").

   - Very large text, high contrast, minimal — usable by a panicked, 

     possibly elderly stranger.

2. OWNER / GUARDIAN PWA (login): 

   - App-like dashboard, bottom tabs (Home, Wards, Profile, Settings).

   - Guardian manages multiple "wards", each with per-field visibility 

     toggles.

=== CATEGORY-DRIVEN THEMING (important) ===

The look changes by category via a color token:

- Medical / emergency = red

- Elderly / kids = green or blue

- Vehicle = yellow / black

- Deaf-mute / communication = its own accent

Build these as theme tokens (CSS variables), so a new category = new 

token, no redesign.

=== ACCESSIBILITY (non-negotiable for this audience) ===

- WCAG AA contrast minimum, large tap targets, scalable font sizes.

- Clear icons + text labels together (not icon-only).

- Simple language, no jargon on the public page.

=== SAFETY ===

- Add a persistent small banner on the public page: 

  "DEMO / PROTOTYPE — not for real emergencies yet."

- Do NOT fake working calls or ambulance dispatch. Buttons can be styled 

  but must clearly show they are demo until backend is connected.

Deliver: the theme system (tokens), PWA setup (manifest + service worker 

+ icons), the two surface layouts, and a category-switch demo.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://safety-spell-theme.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/cbf5ed6d-7680-40ee-aa80-13e3723006fd).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
