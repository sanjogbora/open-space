# Shapespark-Class Web Walkthrough Platform

This repo is being planned as a full product for browser-based architectural walkthroughs: import, edit, optimize, bake lighting, publish, embed, and view scenes across desktop, mobile, and VR-capable browsers.

The goal is not to copy Shapespark branding or proprietary implementation. The goal is to build a comparable product class with similar user ease, visual quality, publishing workflow, and runtime optimization.

## Current Phase

Phase 2: viewer, studio, API, publishing, and first optimization pipeline are in place.

## Local Apps

- Viewer: `pnpm.cmd dev` then open `http://127.0.0.1:5173/`
- Studio: `pnpm.cmd dev:studio` then open `http://127.0.0.1:5174/`
- API: `pnpm.cmd dev:api` then use `http://127.0.0.1:5175/`

## Documents

- [Product Requirements Document](docs/prd.md)
- [Feature Matrix](docs/feature-matrix.md)
- [Technical Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Milestone 1 Plan](docs/milestone-1-viewer.md)
- [Scene Bundle Format](docs/scene-bundle.md)
- [Studio App](docs/studio.md)
- [Pipeline](docs/pipeline.md)
- [Local API](docs/api.md)
- [Current Status](docs/current-status.md)

## Product Pillars

1. Easy import from architecture tools.
2. Scene editor for lights, materials, views, interactions, and publishing settings.
3. Automated optimization pipeline for web delivery.
4. Baked-lighting workflow for realistic scenes with low runtime cost.
5. Smooth browser viewer for desktop, mobile, and embedded usage.
6. Hosting, sharing, embed, custom branding, API, and collaboration.
