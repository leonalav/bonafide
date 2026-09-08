---
name: Bonafide Core
colors:
  surface: '#111318'
  surface-dim: '#111318'
  surface-bright: '#37393e'
  surface-container-lowest: '#0c0e13'
  surface-container-low: '#191c20'
  surface-container: '#1e2024'
  surface-container-high: '#282a2f'
  surface-container-highest: '#33353a'
  on-surface: '#e2e2e9'
  on-surface-variant: '#c3c6d2'
  inverse-surface: '#e2e2e9'
  inverse-on-surface: '#2e3035'
  outline: '#8d919c'
  outline-variant: '#424751'
  surface-tint: '#aac7ff'
  primary: '#aac7ff'
  on-primary: '#002f64'
  primary-container: '#2b5ea7'
  on-primary-container: '#c8d9ff'
  inverse-primary: '#2b5ea7'
  secondary: '#bfc7d4'
  on-secondary: '#29313b'
  secondary-container: '#3f4752'
  on-secondary-container: '#aeb6c2'
  tertiary: '#ffb77a'
  on-tertiary: '#4c2700'
  tertiary-container: '#8f4e00'
  on-tertiary-container: '#ffd0aa'
  error: '#ffb4ab'
  on-error: '#690005'
  error-container: '#93000a'
  on-error-container: '#ffdad6'
  primary-fixed: '#d6e3ff'
  primary-fixed-dim: '#aac7ff'
  on-primary-fixed: '#001b3e'
  on-primary-fixed-variant: '#00458d'
  secondary-fixed: '#dbe3f0'
  secondary-fixed-dim: '#bfc7d4'
  on-secondary-fixed: '#141c25'
  on-secondary-fixed-variant: '#3f4752'
  tertiary-fixed: '#ffdcc2'
  tertiary-fixed-dim: '#ffb77a'
  on-tertiary-fixed: '#2e1500'
  on-tertiary-fixed-variant: '#6d3a00'
  background: '#111318'
  on-background: '#e2e2e9'
  surface-variant: '#33353a'
typography:
  headline-xl:
    fontFamily: Geist Sans
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Geist Sans
    fontSize: 18px
    fontWeight: '500'
    lineHeight: 24px
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  body-sm:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
  code-md:
    fontFamily: Geist Sans
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 22px
  label-caps:
    fontFamily: Geist Sans
    fontSize: 12px
    fontWeight: '600'
    lineHeight: 16px
    letterSpacing: 0.05em
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  unit: 4px
  sidebar-width: 240px
  utility-dock-width: 48px
  gutter: 16px
  margin-sm: 8px
  margin-md: 16px
  margin-lg: 24px
---

## Brand & Style

This design system is engineered for high-performance software development, prioritizing deep focus and technical precision. The aesthetic direction is a hybrid of **Minimalism** and **Glassmorphism**, specifically tailored for a dark-mode-first environment. 

The personality is authoritative, "low-latency," and sophisticated. It avoids the clutter of traditional IDEs by using subtle translucency to establish hierarchy without heavy shadows. The UI should feel like a specialized terminal interface—unconventional yet highly efficient. Key distinctive features include a non-standard vertical utility dock and high-contrast code visualization that treats text as the primary interface element.

## Colors

The palette is rooted in a deep "Charcoal Black" to minimize eye strain during long coding sessions. "Official Blue" serves as the functional primary accent, reserved for active states, primary actions, and critical focus indicators. "Silver" and "Cool Gray" provide a sophisticated grayscale hierarchy for non-essential UI information.

The syntax highlighting system must leverage high-contrast offsets of these colors to ensure code legibility. Background surfaces use a 1px "Steel" border to maintain structural integrity in a low-light environment.

## Typography

This design system uses **Geist Sans** for technical labels, headlines, and code. Its geometric, slightly tech-leaning aesthetic provides the "unconventional" feel required for an IDE. **Inter** is utilized for body copy and documentation to ensure maximum readability and a grounded, professional feel.

The code editor should utilize Geist Sans with a slightly increased line-height (1.6x) to facilitate scanning. All UI labels should use the `label-caps` style to differentiate them from the code content they surround.




## Layout & Spacing

The layout is a **Fluid Grid** that maximizes the editor real estate. It features an unconventional layout: a slim, high-contrast "Utility Dock" (48px) on the extreme left for core navigation, followed by a collapsible "Navigation Sidebar" (240px).

The workspace uses a strict 4px baseline rhythm. Gutters between editor panes are minimal (1px borders) to create a seamless, integrated feel. Padding within panels should be generous (16px) to contrast with the high-density code text.

## Elevation & Depth

This system avoids traditional shadows in favor of **Glassmorphism and Tonal Layers**. 

- **Level 0 (Base):** Charcoal Black (#0D0D0F).
- **Level 1 (Panels):** Dark Navy (#111318) with a 1px Steel (#1E2128) border.
- **Level 2 (Overlays/Modals):** Dark Navy at 80% opacity with a 20px backdrop blur and a Silver (#9BA3AF) hairline border at 20% opacity.

The "Official Blue" primary color is used as a "glow" or "rim light" effect for active focus states rather than an elevation shadow.

## Shapes

The shape language is "Soft-Technical." Most UI components (buttons, input fields, and panel corners) use a precise **0.25rem (4px)** corner radius. This provides a professional, sharp look that is more forgiving than 0px "Brutalist" corners but significantly more modern and disciplined than highly rounded "Consumer" UI. Large cards or modals may occasionally use 0.5rem to denote higher hierarchy.

## Components

### Buttons
- **Primary:** Official Blue background, Clean White text. No border.
- **Secondary:** Transparent background, 1px Steel border, Silver text.
- **Ghost:** Transparent background, Cool Gray text. Blue text on hover.

### Editor Tabs
Tabs are non-rounded and separated by 1px Steel borders. The active tab is indicated by a 2px Official Blue top-border and a subtle Dark Navy background shift.

### Input Fields
Inputs use the Surface color with a 1px Steel border. On focus, the border transitions to Official Blue with a subtle 2px outer glow of the same color. Text uses the Code-MD typography style.

### Utility Dock Icons
Icons in the 48px dock should be Silver by default, shifting to Clean White with an Official Blue vertical "active bar" on the left edge when selected.

### Chips & Badges
Small, 0.25rem rounded elements. For "Danger" states (errors), use Alert Red text with a 10% opacity Alert Red background. For "Info" states, use Silver text.